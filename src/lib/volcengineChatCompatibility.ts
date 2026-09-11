import type { LanguageModelV3, LanguageModelV3CallOptions, LanguageModelV3Content, LanguageModelV3Prompt, LanguageModelV3StreamPart, SharedV3ProviderMetadata } from "@ai-sdk/provider";

const META = "volcengineChat";
function encryptedFromBody(body: unknown, stream: boolean): string | undefined {
  let parsed = body;
  if (typeof parsed === "string") { try { parsed = JSON.parse(parsed); } catch { return undefined; } }
  const choice = (parsed as any)?.choices?.[0];
  const encrypted = (stream ? choice?.delta : choice?.message)?.encrypted_content;
  return typeof encrypted === "string" && encrypted.length > 0 ? encrypted : undefined;
}
function encryptedMetadata(existing: SharedV3ProviderMetadata | undefined, modelId: string, encryptedContent: string): SharedV3ProviderMetadata {
  return { ...existing, [META]: { ...existing?.[META], modelId, encryptedContent } };
}
function replayPrompt(prompt: LanguageModelV3Prompt, modelId: string): LanguageModelV3Prompt {
  return prompt.map(message => {
    if (message.role !== "assistant") return message;
    const explicit = message.providerOptions?.openaiCompatible?.encrypted_content;
    const saved = message.content.map(part => part.providerOptions?.[META]).reverse().find(value => value?.modelId === modelId && typeof value.encryptedContent === "string" && value.encryptedContent.length > 0);
    const encrypted = typeof explicit === "string" && explicit.length > 0 ? explicit : saved?.encryptedContent;
    if (!encrypted) return message;
    // The installed compatible provider forwards message-level openaiCompatible fields.
    // Part-level metadata alone is preserved by AI SDK but not promoted by the provider.
    return { ...message, providerOptions: { ...message.providerOptions, openaiCompatible: { ...message.providerOptions?.openaiCompatible, encrypted_content: encrypted } } };
  });
}
function attachContent(content: LanguageModelV3Content[], modelId: string, encrypted: string): LanguageModelV3Content[] {
  const carrierIndex = content.findIndex(part => part.type === "reasoning");
  if (carrierIndex >= 0) return content.map((part, index) => index === carrierIndex ? { ...part, providerMetadata: encryptedMetadata(part.providerMetadata, modelId, encrypted) } : part);
  // An empty reasoning part transports opaque state without putting ciphertext in visible text.
  return [...content, { type: "reasoning", text: "", providerMetadata: encryptedMetadata(undefined, modelId, encrypted) }];
}

/** Opt-in Ark Chat compatibility, scoped to one SDK model; no shared conversation cache. */
export function withVolcengineChatCompatibility(model: LanguageModelV3): LanguageModelV3 {
  const prepare = (options: LanguageModelV3CallOptions) => ({ ...options, prompt: replayPrompt(options.prompt, model.modelId) });
  return {
    specificationVersion: "v3", provider: model.provider, modelId: model.modelId, supportedUrls: model.supportedUrls,
    async doGenerate(options) {
      const result = await model.doGenerate(prepare(options));
      const encrypted = encryptedFromBody(result.response?.body, false);
      return encrypted ? { ...result, content: attachContent(result.content, model.modelId, encrypted) } : result;
    },
    async doStream(options) {
      const result = await model.doStream({ ...prepare(options), includeRawChunks: true });
      let encrypted: string | undefined;
      let attached: string | undefined;
      return { ...result, stream: result.stream.pipeThrough(new TransformStream<LanguageModelV3StreamPart, LanguageModelV3StreamPart>({
        transform(part, controller) {
          if (part.type === "raw") {
            const encryptedDelta = encryptedFromBody(part.rawValue, true);
            // Current Ark emits one complete delta. Concatenation also preserves opaque
            // bytes if a gateway/future model splits that delta into multiple events.
            if (encryptedDelta) encrypted = (encrypted ?? "") + encryptedDelta;
            if (options.includeRawChunks) controller.enqueue(part);
            return;
          }
          if (part.type === "reasoning-end" && encrypted) {
            attached = encrypted;
            controller.enqueue({ ...part, providerMetadata: encryptedMetadata(part.providerMetadata, model.modelId, encrypted) });
            return;
          }
          if (part.type === "finish" && encrypted && attached !== encrypted) {
            const id = "volcengine-encrypted-state";
            controller.enqueue({ type: "reasoning-start", id });
            controller.enqueue({ type: "reasoning-end", id, providerMetadata: encryptedMetadata(undefined, model.modelId, encrypted) });
            attached = encrypted;
          }
          controller.enqueue(part);
        },
      })) };
    },
  };
}

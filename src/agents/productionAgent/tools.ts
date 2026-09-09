import { tool, jsonSchema, Tool } from "ai";
import { z } from "zod";
import _ from "lodash";
import ResTool from "@/socket/resTool";
import u from "@/utils";
import { addProductionStoryboards, readProductionFlow } from "@/services/productionFlow";
import { notifyProductionChange } from "@/services/productionEvents";
import { createOrUpdateDerivedAsset, deleteDerivedAsset } from "@/services/productionAssets";
import { generateDerivedAssetImages, generateStoryboardImages } from "@/services/productionImages";
import { createProductionImageRuntime } from "@/services/productionImageRuntime";

const deriveAssetSchema = z.object({
  id: z.number().describe("衍生资产ID,如果新增则为空"),
  assetsId: z.number().describe("关联的资产ID"),
  prompt: z.string().describe("生成提示词"),
  name: z.string().describe("衍生资产名称"),
  desc: z.string().describe("衍生资产描述"),
  src: z.string().nullable().describe("衍生资产资源路径"),
  state: z.enum(["未生成", "生成中", "已完成", "生成失败"]).describe("衍生资产生成状态"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("衍生资产类型"),
});
export const assetItemSchema = z.object({
  id: z.number().describe("资产唯一标识"),
  name: z.string().describe("资产名称"),
  type: z.enum(["role", "tool", "scene", "clip"]).describe("资产类型"),
  prompt: z.string().describe("生成提示词"),
  desc: z.string().describe("资产描述"),
  derive: z.array(deriveAssetSchema).describe("衍生资产列表"),
});
const storyboardSchema = z.object({
  id: z.number().describe("分镜ID，必须为真实id"),
  duration: z.number().describe("持续时长(秒)"),
  prompt: z.string().describe("生成提示词"),
  associateAssetsIds: z.array(z.number()).describe("关联资产ID列表"),
  src: z.string().nullable().describe("分镜资源路径"),
  index: z.number().nullable().optional().describe("分镜排序字段"),
});
const workbenchDataSchema = z.object({
  name: z.string().describe("项目名称"),
  duration: z.string().describe("视频时长"),
  resolution: z.string().describe("分辨率"),
  fps: z.string().describe("帧率"),
  cover: z.string().optional().describe("封面图片路径"),
  gradient: z.string().optional().describe("渐变色配置"),
});
const posterItemSchema = z.object({
  id: z.number().describe("海报ID"),
  image: z.string().describe("海报图片路径"),
});
export const flowDataSchema = z.object({
  script: z.string().describe("剧本内容"),
  scriptPlan: z.string().describe("拍摄计划"),
  assets: z.array(assetItemSchema).describe("衍生资产"),
  storyboardTable: z.string().describe("分镜表"),
  storyboard: z.array(storyboardSchema).describe("分镜面板"),
});

export type FlowData = z.infer<typeof flowDataSchema>;

const keySchema = z.enum(Object.keys(flowDataSchema.shape) as [keyof FlowData, ...Array<keyof FlowData>]);
const flowDataKeyLabels = Object.fromEntries(
  Object.entries(flowDataSchema.shape).map(([key, schema]) => [key, (schema as z.ZodTypeAny).description ?? key]),
) as Record<keyof FlowData, string>;

interface ToolConfig {
  resTool: ResTool;
  toolsNames?: string[];
  msg: ReturnType<ResTool["newMessage"]>;
}

export default (toolCpnfig: ToolConfig) => {
  const { resTool, toolsNames, msg } = toolCpnfig;
  const workMap: Record<any, any> = {};
  const tools: Record<string, Tool> = {
    get_flowData: tool({
      description: "获取工作区数据",
      inputSchema: jsonSchema<{ key: keyof FlowData }>(
        z
          .object({
            key: keySchema.describe("数据key"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ key }) => {
        const thinking = msg.thinking(`正在获取${flowDataKeyLabels[key]}工作区数据...`);

        const flowData = await readProductionFlow(u.db, Number(resTool.data.projectId), Number(resTool.data.scriptId), (path) => u.oss.getSmallImageUrl(path));
        thinking.appendText(`获取到${flowDataKeyLabels[key]}:\n` + JSON.stringify(flowData[key], null, 2));
        thinking.updateTitle(`获取${flowDataKeyLabels[key]}完成`);
        thinking.complete();
        if (workMap[key] && JSON.stringify(workMap[key]) === JSON.stringify(flowData[key])) {
          console.info(`[tools] get_flowData: ${flowDataKeyLabels[key]}数据未变化，无需更新`);
          return `${flowDataKeyLabels[key]}数据未变化，无需更新`;
        }
        workMap[key] = flowData[key];
        return flowData[key];
      },
    }),
    add_deriveAsset: tool({
      description: "新增或更新衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number | null; name: string; desc: string }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().nullable().describe("衍生资产ID,如果新增则为空"),
            name: z.string().describe("衍生资产名称"),
            desc: z.string().describe("衍生资产描述"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        // 容错：LLM 偶尔传 "null" 字符串或空串，统一规范为 null
        const idRaw = raw.id as unknown;
        const normalizedId = idRaw === "null" || idRaw === "" || idRaw === undefined ? null : (idRaw as number | null);
        const deriveAsset = { ...raw, id: normalizedId };

        const thinking = msg.thinking("正在操作资产...");
        const { projectId, scriptId } = resTool.data;
        const result = await createOrUpdateDerivedAsset(u.db, { projectId: Number(projectId), scriptId: Number(scriptId), parentAssetId: deriveAsset.assetsId, id: deriveAsset.id, name: deriveAsset.name, description: deriveAsset.desc });
        thinking.appendText(`${result.created ? "已新增" : "已更新"}衍生资产，ID: ${result.id}\n`);
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return result;
      },
    }),
    del_deriveAsset: tool({
      description: "删除衍生资产",
      inputSchema: jsonSchema<{ assetsId: number; id: number }>(
        z
          .object({
            assetsId: z.number().describe("关联的资产ID"),
            id: z.number().describe("衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ assetsId, id }) => {
        const thinking = msg.thinking("正在操作资产...");
        const { scriptId, projectId } = resTool.data;
        const result = await deleteDerivedAsset(u.db, { projectId: Number(projectId), scriptId: Number(scriptId), parentAssetId: assetsId, id });
        thinking.appendText(`已删除衍生资产，ID: ${id}\n`);
        thinking.updateTitle("资产操作完成");
        thinking.complete();
        return result;
      },
    }),
    generate_deriveAsset: tool({
      description: "生成衍生资产图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("需要生成的 衍生资产ID"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成衍生资产...");
        const result = await generateDerivedAssetImages(u.db, { projectId: Number(resTool.data.projectId), scriptId: Number(resTool.data.scriptId), assetIds: ids, runtime: createProductionImageRuntime() });
        thinking.appendText(`衍生资产生成结果:\n${JSON.stringify(result, null, 2)}\n`);
        thinking.updateTitle("衍生资产生成完成");
        thinking.complete();
        return result;
      },
    }),
    generate_storyboard: tool({
      description: "生成分镜图片",
      inputSchema: jsonSchema<{ ids: number[] }>(
        z
          .object({
            ids: z.array(z.number()).describe("必须获取真实的分镜ID，支持批量生成"),
          })
          .toJSONSchema(),
      ),
      execute: async ({ ids }) => {
        const thinking = msg.thinking("正在生成分镜...");
        const result = await generateStoryboardImages(u.db, { projectId: Number(resTool.data.projectId), scriptId: Number(resTool.data.scriptId), storyboardIds: ids, runtime: createProductionImageRuntime() });
        thinking.appendText("生成的分镜数据:\n" + JSON.stringify(result, null, 2));
        thinking.updateTitle("分镜生成完成");
        thinking.complete();
        return result;
      },
    }),
    add_flowData_storyboard: tool({
      description: "新增分镜面板到工作区",
      inputSchema: jsonSchema<{
        videoDesc: string;
        prompt: string | null;
        track: string;
        duration: number;
        associateAssetsIds: number[] | null;
        shouldGenerateImage: string;
      }>(
        z
          .object({
            videoDesc: z.string().describe("画面描述、场景、关联资产名称、时长、景别、运镜、角色动作、情绪、光影氛围、台词、音效、关联资产ID"),
            prompt: z.string().nullable().describe("分镜图片提示词"),
            track: z.string().describe("分组"),
            duration: z.number().describe("视频推荐时间"),
            associateAssetsIds: z.array(z.number()).nullable().describe("该分镜所需的资产ID列表"),
            shouldGenerateImage: z.enum(["true", "false"]).describe("是否需要生成分镜图片"),
          })
          .toJSONSchema(),
      ),
      execute: async (raw) => {
        const thinking = msg.thinking("正在新增 分镜面板 数据...");
        const projectId = Number(resTool.data.projectId);
        const scriptId = Number(resTool.data.scriptId);
        const ids = await addProductionStoryboards(u.db, projectId, scriptId, [{
          videoDesc: raw.videoDesc, prompt: raw.prompt ?? "", track: raw.track,
          duration: raw.duration, associateAssetsIds: raw.associateAssetsIds ?? [],
          shouldGenerateImage: raw.shouldGenerateImage === "true" ? 1 : 0,
        }]);
        notifyProductionChange({ projectId, scriptId });
        thinking.appendText("新增分镜 ID: " + ids.join(", "));
        thinking.updateTitle("新增分镜成功");
        thinking.complete();
        return { success: true, ids };
      },
    }),
  };

  return toolsNames ? Object.fromEntries(Object.entries(tools).filter(([n]) => toolsNames.includes(n))) : tools;
};

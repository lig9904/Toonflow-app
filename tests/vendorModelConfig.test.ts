import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseCustomModels, sortVendorConfigRows, upsertVendorModel, mergeVendorModels } from "../src/lib/vendorModelConfig";

describe("vendor configuration persistence", () => {
  it("orders toonflow first and all remaining vendors by stable id", () => {
    const rows = sortVendorConfigRows([{ id: "zeta" }, { id: "deepseek" }, { id: "toonflow" }, { id: "atlascloud" }]);
    assert.deepEqual(rows.map((row) => row.id), ["toonflow", "atlascloud", "deepseek", "zeta"]);
    const reordered = sortVendorConfigRows([{ id: "deepseek" }, { id: "toonflow" }, { id: "atlascloud" }]);
    assert.deepEqual(reordered.map((row) => row.id), ["toonflow", "atlascloud", "deepseek"]);
  });

  it("updates only the exact modelName and appends a missing model once", () => {
    const first = { name: "First", modelName: "model.first", type: "text", think: false };
    const second = { name: "Second", modelName: "model.second", type: "text", think: true };
    const edited = { ...second, name: "Second edited" };
    const afterEdit = JSON.parse(upsertVendorModel(JSON.stringify([first, second]), second.modelName, edited));
    assert.deepEqual(afterEdit, [first, edited]);
    assert.deepEqual(JSON.parse(upsertVendorModel(JSON.stringify(afterEdit), second.modelName, edited)), [first, edited]);
    const added = { name: "Third", modelName: "model.third", type: "text", think: false };
    const once = JSON.parse(upsertVendorModel(JSON.stringify(afterEdit), added.modelName, added));
    const twice = JSON.parse(upsertVendorModel(JSON.stringify(once), added.modelName, added));
    assert.deepEqual(twice, [first, edited, added]);
  });

  it("supports renaming the exact old model ID and rejects collisions", () => {
    const first = { name: "First", modelName: "model.first", type: "text", think: false };
    const second = { name: "Second", modelName: "model.second", type: "text", think: true };
    const renamed = { ...second, modelName: "model.renamed" };
    assert.deepEqual(JSON.parse(upsertVendorModel(JSON.stringify([first, second]), "model.second", renamed)), [first, renamed]);
    assert.throws(() => upsertVendorModel(JSON.stringify([first, second]), "model.second", { ...second, modelName: "model.first" }), /模型ID已存在/);
    assert.throws(() => upsertVendorModel("{broken", "missing", first), /配置损坏/);
    assert.throws(() => upsertVendorModel(JSON.stringify({ modelName: "wrong" }), "missing", first), /格式无效/);
  });

  it("does not erase custom models when the template is temporarily absent", () => {
    const custom = [{ name: "Custom", modelName: "custom.model", type: "text", think: false }];
    assert.deepEqual(parseCustomModels(JSON.stringify(custom)), custom);
    assert.deepEqual(parseCustomModels("not-json"), []);
  });
});

it("same-model edits preserve capabilities, renamed models never inherit them",()=>{
 const base={modelName:"flash",type:"text",name:"Flash",supportsVision:true,maxOutputTokens:384000,think:true};
 const edited={modelName:"flash",type:"text",name:"My Flash",think:false};
 assert.deepEqual(mergeVendorModels([base],[edited]),[{...base,...edited}]);
 assert.equal(mergeVendorModels([base],[{...edited,supportsVision:false}])[0].supportsVision,false);
 assert.equal(JSON.parse(upsertVendorModel(JSON.stringify([base]),"flash",edited))[0].maxOutputTokens,384000);
 assert.equal(JSON.parse(upsertVendorModel(JSON.stringify([base]),"flash",{...edited,modelName:"other"}))[0].supportsVision,undefined);
 assert.equal(mergeVendorModels([base],[{...edited,type:"image"}])[0].supportsVision,undefined);
});

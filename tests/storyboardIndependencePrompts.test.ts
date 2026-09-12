import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { promptDefaults, commonPromptSeeds, storyboardIndependencePolicy } from "../src/lib/promptDefaults";
import { productionDecisionPrompt, productionStageContract } from "../src/services/builtinAgent/productionPrompts";
import { promptDefinitions } from "../src/services/promptRegistry";
const skills = path.resolve("data/skills");
const read = (name: string) => fs.readFile(path.join(skills, name), "utf8");

test("registered generation/review defaults and actual production stage contract carry independent-shot semantics", () => {
  for (const key of ["videoPromptGeneration", "videoPromptReview"] as const) {
    assert.ok(promptDefaults[key].includes(storyboardIndependencePolicy));
    assert.ok(promptDefinitions.find(entry => entry.key === `${key === "videoPromptReview" ? "review" : "common"}.${key}`)?.defaultContent?.includes(storyboardIndependencePolicy));
  }
  assert.ok(commonPromptSeeds.find(entry => entry.type === "videoPromptGeneration")?.data.includes(storyboardIndependencePolicy));
  assert.ok(productionDecisionPrompt.includes(storyboardIndependencePolicy));
  assert.match(productionStageContract("productionAgent:storyboardTableAgent"), /一镜一独立视频生成片段/);
  assert.match(productionStageContract("productionAgent:storyboardTableAgent"), /track 字符串仅作分类标签/);
});

test("builtin director, storyboard and review keep rows separate and do not fake historical migration", async () => {
  for (const name of ["builtin_production_director.md", "builtin_production_storyboard.md", "builtin_production_review.md"]) {
    const content = await read(name);
    assert.match(content, /一镜一独立视频生成片段/);
    assert.match(content, /track 字符串仅作分类标签/);
    assert.match(content, /相同或缺省标签均不表示合并/);
    assert.match(content, /不复制整段提示词或视频/);
  }
});

test("legacy panel/table no longer collapse a group into one row or sum several shots to a fixed duration", async () => {
  for (const name of ["production_execution_storyboard_panel.md", "production_execution_storyboard_table.md", "production_agent_decision.md", "production_agent_supervision.md"]) {
    const content = await read(name);
    assert.match(content, /一镜一独立视频生成片段/);
    assert.match(content, /剪辑阶段组合/);
    for (const old of [/以表内「组」为写入单位/, /每个组写入一条分镜/, /每组一次/, /直接取该组标注时长/, /分组累计时长不得超过/, /片段累计 ≤15s/, /片段内切镜/]) assert.doesNotMatch(content, old);
  }
  const panel = await read("production_execution_storyboard_panel.md");
  assert.match(panel, /每行输出一个标签/); assert.match(panel, /每行调用一次/); assert.match(panel, /两种形式不重复提交/);
});

test("every narrative style's long-take/merge tips are explicitly restricted to initial shot design", async () => {
  const folders = await fs.readdir(path.join(skills, "story_skills"), {withFileTypes:true});
  let checked = 0;
  for (const folder of folders.filter(entry => entry.isDirectory())) {
    const file = path.join("story_skills", folder.name, "driector_skills", "director_storyboard_table_narrative.md");
    const content = await read(file).catch(() => ""); if (!content) continue;
    assert.match(content, /不是合并已存分镜或生成片段的指令/);
    assert.match(content, /已有分镜、人工指定镜数与逐镜生成规则优先/); checked++;
  }
  assert.ok(checked >= 10);
});

test("legacy tool fields preserve their API names while clarifying independent units", async () => {
  const source = await fs.readFile(path.resolve("src/agents/productionAgent/tools.ts"), "utf8");
  assert.match(source, /track: z\.string\(\)\.describe\("分类标签/);
  assert.match(source, /duration: z\.number\(\)\.describe\("当前这一镜的视频时长/);
  const dispatcher = await fs.readFile(path.resolve("src/agents/productionAgent/index.ts"), "utf8");
  assert.match(dispatcher, /每条分镜单独输出一个storyboardItem/);
  assert.match(dispatcher, /track='分类标签'/);
  assert.doesNotMatch(dispatcher, /track='分组'/);
});

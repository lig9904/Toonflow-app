import path from "path";
import isPathInside from "is-path-inside";

export default (fileName?: string[] | string) => {
  if (fileName === "oss" && process.env.TOONFLOW_MEDIA_DIR) {
    if (!path.isAbsolute(process.env.TOONFLOW_MEDIA_DIR)) throw new Error("TOONFLOW_MEDIA_DIR 必须是绝对路径");
    return path.resolve(process.env.TOONFLOW_MEDIA_DIR);
  }
  let basePath: string;
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    const userDataDir: string = app.getPath("userData");
    basePath = path.join(userDataDir, "data");
  } else {
    basePath = process.env.TOONFLOW_DATA_DIR ? path.resolve(process.env.TOONFLOW_DATA_DIR) : path.join(process.cwd(), "data");
  }
  if (fileName) {
    let dbPath: string;
    if (Array.isArray(fileName)) {
      dbPath = path.resolve(basePath, ...fileName);
    } else {
      dbPath = path.resolve(basePath, fileName);
    }
    if (!isPathInside(dbPath, basePath) && dbPath !== basePath) {
      throw new Error("路径逃逸错误，路径必须在数据目录内");
    }
    return dbPath;
  }
  return basePath;
};

export function isEletron() {
  if (typeof process.versions?.electron !== "undefined") {
    const { app } = require("electron");
    return true;
  } else {
    return false;
  }
}

export const CUSTOM_UPDATE_REPOSITORIES = {
  backend: "https://github.com/lig9904/Toonflow-app",
  frontend: "https://github.com/lig9904/Toonflow-web",
  upstream: "https://github.com/HBAI-Ltd/Toonflow-app",
} as const;

export function managedUpdatePayload(version: string) {
  return {
    needUpdate: false,
    managed: true,
    policy: "managed" as const,
    version,
    latestVersion: version,
    reinstall: false,
    time: 0,
    message: "定制版由管理员部署更新",
    repositories: CUSTOM_UPDATE_REPOSITORIES,
  };
}

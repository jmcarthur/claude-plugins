export type TidySnapshot = { [key: string]: unknown };

declare module "claude-code" {
  interface PluginState {
    tidy: { session: TidySnapshot };
  }
}

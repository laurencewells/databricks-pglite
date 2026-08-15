import {
  Plugin,
  toPlugin,
  type BasePluginConfig,
  type PluginManifest,
} from "@databricks/appkit";

interface DurabilityLifecycleConfig extends BasePluginConfig {
  onShutdown?: () => Promise<void>;
}

class DurabilityLifecyclePlugin extends Plugin<DurabilityLifecycleConfig> {
  static manifest = {
    name: "durability-lifecycle",
    displayName: "PGlite durability lifecycle",
    description: "Checkpoints and closes PGlite during AppKit shutdown",
    resources: { required: [], optional: [] },
  } satisfies PluginManifest<"durability-lifecycle">;

  async shutdown(): Promise<void> {
    await this.config.onShutdown?.();
  }
}

export const durabilityLifecycle = toPlugin(DurabilityLifecyclePlugin);

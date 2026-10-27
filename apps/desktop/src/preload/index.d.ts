import type { TwinBridge } from "@twinly/shared";

declare global {
  interface Window {
    twin: TwinBridge;
  }
}

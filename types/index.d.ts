// The current turn as the mod has seen it, held by the host so it survives a
// reload of the mod's code.
export type Turn = {
  isWorking: boolean
  // The turn's next-step box asks you something.
  isAsking: boolean
  // Background work was still running when the turn ended.
  hasTasks?: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'status-dots': {
      turn: Turn
    }
  }
}

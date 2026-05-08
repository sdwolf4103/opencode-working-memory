export const VISIBLE_COMMANDS = ["status", "rejected", "missing", "explain", "commands", "revert"] as const;
export const HIDDEN_COMMANDS = ["coverage", "audit"] as const;

export type VisibleCommand = typeof VISIBLE_COMMANDS[number];
export type HiddenCommand = typeof HIDDEN_COMMANDS[number];
export type Command = VisibleCommand | HiddenCommand;

export const HIDDEN_COMMAND_NOTICES: Partial<Record<Command, string>> = {
  coverage: "Note: 'coverage' is a maintainer-only diagnostic and is not part of the public CLI surface.",
  audit: "Note: 'audit' is a maintainer-only diagnostic and is not part of the public CLI surface.",
};

export function isCommand(value: string | undefined): value is Command {
  return value !== undefined
    && ([...VISIBLE_COMMANDS, ...HIDDEN_COMMANDS] as readonly string[]).includes(value);
}

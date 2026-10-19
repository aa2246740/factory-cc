/** Native side effects and independent execution/registry paths must go through Droid. */
export const DESKTOP_DISALLOWED_TOOLS = [
  "Write", "Edit", "MultiEdit", "NotebookEdit", "Bash", "KillShell", "TaskStop", "TaskOutput",
  "Agent", "Task", "Skill", "EnterWorktree", "ExitWorktree", "EnterPlanMode", "ExitPlanMode",
  "TodoWrite", "TaskCreate", "TaskUpdate", "TaskGet", "TaskList", "CronCreate", "CronDelete", "CronList",
  "WebFetch", "WebSearch", "ToolSearch", "AskUserQuestion", "LSP",
  "RefreshMcpTools", "Mcp", "ReportFindings", "SendFeedback", "ClaudeDesign", "Projects", "Workflow",
  "ScheduleWakeup", "RemoteTrigger", "ShowOnboardingRolePicker", "OfferChromeSetup", "ReadNotifications",
  "Monitor", "ProposeSkills", "ProposeGoal", "Artifact", "PushNotification",
];
export const DESKTOP_APPROVAL_DENIAL = "Desktop profile: native approvals are disabled. Use the advertised mcp__droid__ tools so Droid applies its current mode and approval UI.";
/** A native read needs approval only outside the project; Droid attachment copies live there too. */
export const DESKTOP_READ_DENIAL = "Desktop profile: this read is outside the project directory and needs an approval native tools cannot get here. Images the user attached are already in the conversation; use them directly. For other files outside the project, use mcp__droid__Execute (for example cat) so Droid applies its current mode and approval UI.";

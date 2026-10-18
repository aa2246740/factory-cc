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

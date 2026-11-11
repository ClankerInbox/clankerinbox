export {
  ClankerInbox, poll, send, ask, code, newTag, validTag, normalTag,
  type ClankerInboxOptions, type SendInput, type SendOutput, type AskInput, type PollResult,
  type Unmatched, type Request, type CodeInput, type CodeResult, type Answer, type Question, type Config, type InboxConfig,
} from './src/clankerinbox.ts'
export { setup, addInbox, type SetupInput, type SetupResult, type AddInboxInput } from './src/setup.ts'
export { loadConfig, configPath, stateDir } from './src/config.ts'
export {
  checkSender, checkRecipients, isBounce, isAutomated, automation, AGENT_MAIL, stripQuoted, answerText, matchOption, extractCode, maskSecrets, LOOP_HEADERS,
} from './src/safety.ts'
export { Store } from './src/store.ts'
export { ClankerError, type ErrorKind } from './src/errors.ts'

// The old class name, for callers written when the tool was called agentmail.
export { ClankerInbox as AgentMail } from './src/clankerinbox.ts'

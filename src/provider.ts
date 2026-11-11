// The seam between clankerinbox and a mail service. A provider only moves mail:
// it sends, and it lists inbound mail in one normalized shape. Every rule about
// which mail counts lives in safety.ts and clankerinbox.ts, so it runs the same
// whatever the provider.

import type { Config, InboxConfig } from './config.ts'
import { PostShibaProvider } from './postshiba.ts'
import { CloudflareProvider } from './cloudflare-provider.ts'

export type ProviderName = 'postshiba' | 'cloudflare'
export const PROVIDERS: ProviderName[] = ['postshiba', 'cloudflare']

export interface Attachment {
  filename: string
  contentType: string
  size: number | null
}

// One inbound mail, as every provider hands it over.
export interface Mail {
  // Stable per provider and inbox, so a mail is processed once.
  id: string
  // The address the mail was delivered to, plus tag included.
  to: string
  // The sender the provider saw (envelope or parsed From); compared with the From header.
  from: string | null
  subject: string
  text: string
  // The HTML part, when the mail has one: its structure marks the signature and the quote.
  html?: string
  // The plus tag of the address the mail was delivered to.
  tag: string | null
  inReplyTo: string | null
  // Lowercase header names.
  headers: Record<string, string | string[]>
  // The envelope sender: null or '' means a bounce; undefined means the provider does not know it.
  mailFrom?: string | null
  // DMARC as a trusted party saw it (the provider's own check, or an Authentication-Results
  // header from the configured trusted server). Null means no trusted result: it counts as fail.
  dmarc: { result: string; aligned: boolean } | null
  attachments: Attachment[]
  // When the mail arrived, in ms; null when the provider cannot tell.
  receivedAt: number | null
  // The mail was too large to keep whole: its text may be cut, and attachments have no body.
  truncated?: boolean
}

export interface OutgoingMail {
  from: string
  to: string[]
  replyTo: string
  subject: string
  text: string
  html?: string
  headers: Record<string, string>
}

// Per call: how long one request may take, so a command never runs much past its own timeout.
export interface CallOptions {
  timeoutMs?: number
  // listInbound: only mail received at or after this time (ms) is needed. A provider may
  // still return older mail.
  since?: number
  // listInbound: ids the caller has read before. A provider may return such mail with only
  // `id` and `receivedAt` filled in, so it is not parsed again.
  known?: (id: string) => boolean
}

export interface Provider {
  readonly name: ProviderName
  // Throws unless the mail was accepted for delivery.
  send(mail: OutgoingMail, opts?: CallOptions): Promise<{ messageId: string | null }>
  // Mail in this inbox that the provider still holds, newest first: all of it, never only
  // the newest page.
  listInbound(inbox: InboxConfig, opts?: CallOptions): Promise<Mail[]>
  // How long the provider keeps inbound mail, when it says so; processed ids must outlive it.
  retentionHours?: number
  // The Reply-To header of one listed mail, for a provider whose listing leaves it out. Optional:
  // without it, the Reply-To in `headers` is all there is.
  replyTo?(inbox: InboxConfig, mail: Mail, opts?: CallOptions): Promise<string | null>
  // Steps that prove the config works (keys set, logins accepted) without sending mail.
  // Optional, so a provider injected from outside does not have to offer them.
  checks?(): Check[]
}

export interface Check {
  label: string
  // Throws when the step fails. `warn`: the step passed, but something should change.
  run(): Promise<void | { warn: string }>
}

export type Env = Record<string, string | undefined>

export function providerName(config: Config): ProviderName {
  return config.provider || 'postshiba'
}

export function createProvider(config: Config, env: Env): Provider {
  const name = providerName(config)
  if (name === 'postshiba') return new PostShibaProvider(config, env)
  if (name === 'cloudflare') return new CloudflareProvider(config, env)
  throw new Error(`provider ${name} is not supported`)
}

export function plusTagOf(address: string | null | undefined): string | null {
  if (!address) return null
  const at = address.lastIndexOf('@')
  const local = at < 0 ? address : address.slice(0, at)
  const i = local.indexOf('+')
  // Tags are lowercase everywhere; a mail system may keep or change the case of the address.
  return i < 0 || i === local.length - 1 ? null : local.slice(i + 1).toLowerCase()
}

// Attachment metadata read defensively: only names, types and sizes leave clankerinbox.
export function attachmentInfo(a: any): Attachment {
  const size = Number(a?.size ?? a?.byte_size ?? a?.bytes)
  return {
    filename: String(a?.filename ?? a?.name ?? 'attachment'),
    contentType: String(a?.content_type ?? a?.contentType ?? 'application/octet-stream'),
    size: Number.isFinite(size) ? size : null,
  }
}

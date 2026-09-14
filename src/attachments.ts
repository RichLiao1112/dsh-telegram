/**
 * Telegram inbound media intake: Bot API download, durable attachment
 * admission, and the command-submission form the Host command registry accepts.
 */

import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { ImageMediaType, PromptContentPart } from '@deepseek-ai/dsh-attachment'
import type { CommandSubmitAttachment } from '@deepseek-ai/dsh-commands'
import type { ContentBlock } from '@deepseek-ai/dsh-llm/types'
import type {} from '@deepseek-ai/dsh-client-file-upload'

/** Media types the attachment service stores as normalized images. */
const IMAGE_MEDIA_TYPES: readonly string[] = ['image/png', 'image/jpeg', 'image/webp', 'image/gif']

/** One inbound Telegram media reference before download. */
export interface TelegramMediaInput {
  /** Bot API file identifier accepted by `getFile`. */
  readonly fileId: string
  /** Display name; the attachment service sanitizes the stored leaf name. */
  readonly name: string
  /** Image media type when the update itself identifies a supported image. */
  readonly mediaType?: ImageMediaType
}

/** Download one Bot API file into memory. */
export type TelegramFileLoader = (fileId: string) => Promise<Uint8Array>

/** @returns whether the media type is one the attachment service admits as an image. */
function asImageMediaType(mediaType: string | undefined): ImageMediaType | undefined {
  return mediaType !== undefined && IMAGE_MEDIA_TYPES.includes(mediaType)
    ? mediaType as ImageMediaType
    : undefined
}

/**
 * Admit inbound media as ordinary follow-up content: images become durable
 * image references and everything else a durable file reference the model can
 * open by path. Text keeps its position ahead of the media it describes.
 * @param ctx - Host context carrying the attachment service.
 * @param inputs - inbound media in message order.
 * @param text - caption or message text; omitted when empty.
 * @param load - Bot API download for one file id.
 * @param signal - cancellation owned by the receiving update.
 * @returns admitted content blocks for `createUserMessage`.
 * @throws {Error} when no attachment service is mounted or a download fails.
 */
export async function admitTelegramPrompt(
  ctx: Context,
  inputs: readonly TelegramMediaInput[],
  text: string,
  load: TelegramFileLoader,
  signal: AbortSignal,
): Promise<ContentBlock[]> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) throw new Error('Telegram media is unavailable: this deployment mounts no attachment service')
  const content: ContentBlock[] = text === '' ? [] : [{ type: 'text', text }]
  for (const input of inputs) {
    signal.throwIfAborted()
    const data = Buffer.from(await load(input.fileId)).toString('base64')
    const mediaType = asImageMediaType(input.mediaType)
    if (mediaType === undefined) {
      content.push({ type: 'file', attachment: await attachments.admitEncodedFile({ data, name: input.name }) })
      continue
    }
    const admitted = await attachments.admitPromptContent([{ type: 'image', mediaType, data, name: input.name } satisfies PromptContentPart])
    const image = admitted[0]
    if (image === undefined || image.type !== 'image') throw new Error('Telegram media admission returned no image reference')
    content.push({ type: 'image', attachment: image.attachment })
  }
  return content
}

/**
 * Stage inbound media for a slash invocation: images travel as encoded parts,
 * and files become Agent-scoped upload receipts the command registry resolves.
 * @param ctx - Host context carrying the browser upload service.
 * @param agent - receiving Agent whose scope owns the file receipts.
 * @param inputs - inbound media in message order.
 * @param load - Bot API download for one file id.
 * @param signal - cancellation owned by the receiving update.
 * @returns attachments accepted by `commands.execute`.
 * @throws {Error} when a file needs the upload service and none is mounted.
 */
export async function stageTelegramSubmissions(
  ctx: Context,
  agent: Agent,
  inputs: readonly TelegramMediaInput[],
  load: TelegramFileLoader,
  signal: AbortSignal,
): Promise<CommandSubmitAttachment[]> {
  const submissions: CommandSubmitAttachment[] = []
  for (const input of inputs) {
    signal.throwIfAborted()
    const data = Buffer.from(await load(input.fileId)).toString('base64')
    const mediaType = asImageMediaType(input.mediaType)
    if (mediaType !== undefined) {
      submissions.push({ type: 'image', mediaType, data, name: input.name })
      continue
    }
    const uploads = ctx.get('fileUploads')
    if (uploads === undefined) throw new Error('File attachments for commands are unavailable: this deployment mounts no upload service')
    const staged = await uploads.upload(agent, { data, name: input.name }, signal)
    submissions.push({ type: 'file', receiptId: staged.receiptId })
  }
  return submissions
}

/** One inbound update field that carries files, described by its extractor. */
interface TelegramMediaFields {
  readonly photo?: readonly { readonly file_id?: string; readonly file_size?: number }[]
  readonly document?: { readonly file_id?: string; readonly file_name?: string; readonly mime_type?: string; readonly file_size?: number }
  readonly audio?: { readonly file_id?: string; readonly file_name?: string; readonly mime_type?: string; readonly file_size?: number }
  readonly video?: { readonly file_id?: string; readonly file_name?: string; readonly mime_type?: string; readonly file_size?: number }
  readonly voice?: { readonly file_id?: string; readonly mime_type?: string; readonly file_size?: number }
  readonly animation?: { readonly file_id?: string; readonly file_name?: string; readonly mime_type?: string; readonly file_size?: number }
  readonly video_note?: { readonly file_id?: string; readonly file_size?: number }
  readonly sticker?: { readonly file_id?: string; readonly is_animated?: boolean; readonly is_video?: boolean; readonly file_size?: number }
}

/** Bot API download ceiling for `getFile`. */
export const TELEGRAM_FILE_MAX_BYTES = 20_000_000

/**
 * Collect the inbound files of one update in message order.
 * @param message - the update's message fields.
 * @param fallbackName - name used when Telegram reports none.
 * @returns media inputs; empty when the update carries no file.
 * @throws {Error} when a reported file exceeds the Bot API download ceiling.
 */
export function collectTelegramMedia(message: TelegramMediaFields, fallbackName = 'telegram-file'): TelegramMediaInput[] {
  const media: TelegramMediaInput[] = []
  const require = (fileId: string | undefined, size: number | undefined, name: string, mediaType?: string): void => {
    if (fileId === undefined) return
    if (size !== undefined && size > TELEGRAM_FILE_MAX_BYTES) {
      throw new Error(`Telegram file "${name}" exceeds the ${TELEGRAM_FILE_MAX_BYTES / 1_000_000} MB Bot API download limit.`)
    }
    media.push({ fileId, name, ...mediaType === undefined ? {} : { mediaType: mediaType as ImageMediaType } })
  }
  const largest = message.photo?.[message.photo.length - 1]
  require(largest?.file_id, largest?.file_size, fallbackName === 'telegram-file' ? 'telegram-photo.jpg' : fallbackName, 'image/jpeg')
  const document = message.document
  require(document?.file_id, document?.file_size, document?.file_name ?? fallbackName, document?.mime_type)
  const audio = message.audio
  require(audio?.file_id, audio?.file_size, audio?.file_name ?? 'telegram-audio', audio?.mime_type)
  const video = message.video
  require(video?.file_id, video?.file_size, video?.file_name ?? 'telegram-video.mp4', video?.mime_type)
  const voice = message.voice
  require(voice?.file_id, voice?.file_size, 'telegram-voice.ogg', voice?.mime_type)
  const animation = message.animation
  require(animation?.file_id, animation?.file_size, animation?.file_name ?? 'telegram-animation', animation?.mime_type)
  const note = message.video_note
  require(note?.file_id, note?.file_size, 'telegram-video-note.mp4', 'video/mp4')
  const sticker = message.sticker
  if (sticker === undefined) return media
  const staticSticker = sticker.is_animated !== true && sticker.is_video !== true
  require(sticker.file_id, sticker.file_size, staticSticker ? 'telegram-sticker.webp' : 'telegram-sticker', staticSticker ? 'image/webp' : undefined)
  return media
}

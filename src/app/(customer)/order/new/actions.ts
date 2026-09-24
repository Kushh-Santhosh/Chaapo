/**
 * The three actions the upload panel calls, and the boundary they defend.
 *
 * A Server Action is a public POST endpoint with a generated name. Everything a route
 * handler would have to do, these do: they establish who is asking (the draft cookie, minted
 * here rather than during render), they re-derive the shop's caps from the shop row instead
 * of believing anything the client sent, and they return a plain serialisable shape with no
 * `Result` and no `AppError` in it — a client component cannot be handed a class instance.
 *
 * What is *not* here is any decision about whether a file is acceptable. That lives in the
 * files domain, which the browser cannot reach. These functions carry identity across the
 * wire and nothing else.
 *
 * The client sends a `shopSlug`, never a `shopId` and never caps. A slug is the thing already
 * in the URL bar, so it leaks nothing new, and looking it up here means a customer cannot
 * raise their own page limit by editing a form field.
 */

'use server'

import {
  beginUpload,
  completeUpload,
  listDraft,
  removeFile,
  totalsOf,
  type DraftFile,
  type ShopCaps,
  type UploadTicket,
} from '@/server/domains/files'
import { getShop } from '@/server/domains/discovery'
import { isErr } from '@/server/core/result'
import { requireDraftOwnerId } from '@/server/http/draft-identity'

/**
 * What a client component may receive.
 *
 * A discriminated union rather than a thrown error: every one of these outcomes is something
 * a customer can cause, and each has a sentence the panel is meant to show. `ok: false` with
 * a message is the whole contract — the panel never inspects a code.
 */
export type ActionResult<T> = { ok: true; data: T } | { ok: false; message: string }

/** The draft as a screen renders it: the files, and the one-line totals under them. */
export interface DraftView {
  files: DraftFile[]
  totals: { files: number; bytes: number; pages: number }
}

/**
 * Resolve a slug to the shop's id and its own caps.
 *
 * `getShop` returns `null` for a shop that is unverified, not live or suspended, exactly as
 * the profile page relies on — so an unverified shop cannot receive uploads even if someone
 * knows its slug.
 */
async function shopFor(
  slug: string,
): Promise<{ id: string; caps: ShopCaps } | { message: string }> {
  const shop = await getShop(slug)
  if (!shop) return { message: 'That shop is no longer taking orders.' }
  return {
    id: shop.id,
    caps: { maxFilesPerOrder: shop.maxFilesPerOrder, maxPagesPerOrder: shop.maxPagesPerOrder },
  }
}

export interface BeginUploadInput {
  shopSlug: string
  filename: string
  declaredMime: string
  byteSize: number
}

/**
 * Step 1: ask for permission and a credential.
 *
 * The size and type here are *declared* — this is what the browser claims before any bytes
 * move. `refuseIntent` inside the domain uses them to refuse the cheap cases; `completeUpload`
 * later checks what actually arrived. A client that lies gets a credential and then a
 * rejection, which costs it a round trip and gains it nothing.
 */
export async function beginUploadAction(
  input: BeginUploadInput,
): Promise<ActionResult<UploadTicket>> {
  if (typeof input?.filename !== 'string' || !Number.isFinite(input?.byteSize)) {
    return { ok: false, message: 'That file could not be read. Try selecting it again.' }
  }

  const shop = await shopFor(input.shopSlug)
  if ('message' in shop) return { ok: false, message: shop.message }

  // Minted here rather than in the page: Next forbids setting a cookie during render, and
  // an action is the first point in the flow where writing one is legal.
  const ownerUserId = await requireDraftOwnerId()

  const result = await beginUpload({
    ownerUserId,
    shopId: shop.id,
    intent: {
      filename: input.filename,
      declaredMime: typeof input.declaredMime === 'string' ? input.declaredMime : '',
      byteSize: Math.floor(input.byteSize),
    },
    caps: shop.caps,
  })

  // `AppError.message` on these paths is already a sentence written for a customer — the
  // refusals come from `limits.ts`, which exists to phrase them.
  if (isErr(result)) return { ok: false, message: result.error.message }
  return { ok: true, data: result.value }
}

/**
 * Step 3: find out what actually arrived.
 *
 * Returns the whole draft rather than the one file, because a completed upload changes the
 * totals line as well as its own row, and one round trip that returns the truth beats two
 * that return halves of it.
 *
 * A `rejected` file is `ok: true`. The upload succeeded as an operation; the file is simply
 * not printable, and its own `rejectionMessage` says why. Reporting that as an action failure
 * would lose the row the customer needs to see and remove.
 */
export async function completeUploadAction(
  input: { shopSlug: string; fileId: string },
): Promise<ActionResult<DraftView>> {
  const shop = await shopFor(input.shopSlug)
  if ('message' in shop) return { ok: false, message: shop.message }

  const ownerUserId = await requireDraftOwnerId()
  const result = await completeUpload(ownerUserId, input.fileId)
  if (isErr(result)) return { ok: false, message: result.error.message }

  return { ok: true, data: await draftView(ownerUserId, shop.id) }
}

/** Remove one file from the draft, bytes and row together. */
export async function removeFileAction(
  input: { shopSlug: string; fileId: string },
): Promise<ActionResult<DraftView>> {
  const shop = await shopFor(input.shopSlug)
  if ('message' in shop) return { ok: false, message: shop.message }

  const ownerUserId = await requireDraftOwnerId()
  const result = await removeFile(ownerUserId, input.fileId)
  if (isErr(result)) return { ok: false, message: result.error.message }

  return { ok: true, data: await draftView(ownerUserId, shop.id) }
}

/**
 * Re-read the draft.
 *
 * The panel calls this when it comes back to a page it has already used, so a reload or a
 * back-navigation shows the files that really exist rather than the ones the last render
 * happened to know about.
 */
export async function readDraftAction(input: { shopSlug: string }): Promise<ActionResult<DraftView>> {
  const shop = await shopFor(input.shopSlug)
  if ('message' in shop) return { ok: false, message: shop.message }

  const ownerUserId = await requireDraftOwnerId()
  return { ok: true, data: await draftView(ownerUserId, shop.id) }
}

async function draftView(ownerUserId: string, shopId: string): Promise<DraftView> {
  const files = await listDraft(ownerUserId, shopId)
  return { files, totals: totalsOf(files) }
}

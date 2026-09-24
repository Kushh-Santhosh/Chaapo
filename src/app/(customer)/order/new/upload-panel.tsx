/**
 * The upload panel — C-07's only interactive part.
 *
 * The design constraint that shapes everything here: **the bytes do not pass through this
 * application.** So an upload is three steps, not one, and the panel has to be honest at
 * each of them:
 *
 * 1. `beginUploadAction` — the server decides whether the file is allowed and hands back a
 *    short-lived credential for one key. A refusal arrives here as a sentence and is shown
 *    against the file that caused it. Nothing has been uploaded.
 * 2. `XMLHttpRequest.send(file)` straight to storage. `XMLHttpRequest` rather than `fetch`
 *    for one reason: `upload.onprogress`. A 40 MB scan on a phone is a minute of waiting,
 *    and a bar that moves is the difference between waiting and closing the tab.
 * 3. `completeUploadAction` — the server reads what actually arrived, sniffs it and counts
 *    the pages. **This is the only step that may say a file is ready.** Until it answers,
 *    the row says "checking", because at that moment nobody knows whether the file is
 *    printable.
 *
 * A file that reaches step 3 and comes back `rejected` is not an error: it is a real answer,
 * shown with its own reason and a way to remove it. The one thing this component must never
 * do is show a green tick because a PUT returned 200.
 */

'use client'

import { useCallback, useEffect, useRef, useState, useTransition } from 'react'
import {
  AlertTriangle,
  CheckCircle2,
  FileText,
  Loader2,
  Plus,
  RefreshCw,
  Trash2,
  X,
} from 'lucide-react'

import { Badge } from '@/components/ui/badge'
import { Button, IconButton } from '@/components/ui/button'
import { Card } from '@/components/ui/card'
import { Notice } from '@/components/ui/states'
import { StickyActionBar } from '@/components/shell/sticky-action-bar'
import { cn } from '@/lib/cn'
// Straight at the two leaf modules, not at `@/server/domains/files`. The barrel re-exports
// `service.ts`, which reaches `repo.ts` and therefore `pg` — and webpack follows that into
// the client bundle even though the import is dynamic, which fails the build on `net`/`tls`.
// `limits.ts` is documented as dependency-free precisely so a client may share it, and
// `model.ts` is types only.
import { ACCEPT_ATTRIBUTE, formatBytes } from '@/server/domains/files/limits'

import type { DraftFile } from '@/server/domains/files/model'

import {
  beginUploadAction,
  completeUploadAction,
  readDraftAction,
  removeFileAction,
  type DraftView,
} from './actions'

/**
 * A file the browser is still working on.
 *
 * Deliberately separate from `DraftFile`: this one has no server row worth showing yet, and
 * its `name` is the customer's own filename, which only ever lives in this component's
 * memory. Once step 3 answers, the entry disappears and a real `DraftFile` takes its place —
 * labelled "File 3.pdf", because that is the only name the server will admit to.
 */
interface PendingUpload {
  /** Local only. Not the file id. */
  localId: string
  name: string
  byteSize: number
  /** 0–100 while sending; `null` once the bytes are gone and the server is checking. */
  percent: number | null
  phase: 'reserving' | 'sending' | 'checking'
}

export interface UploadPanelProps {
  shopSlug: string
  shopName: string
  initialDraft: DraftView
  /** The shop's own ceiling, for the "3 of 10 files" line. `null` when it has not set one. */
  maxFiles: number | null
  maxPages: number | null
  /** True when bytes are going to a local disk. Said in words, never hidden. */
  developmentStorage: boolean
  /** Called when the draft changes (file uploaded, removed, etc). */
  onUploadChange?: (draft: DraftView) => void
  /** Called when the customer is ready to continue to print options. */
  onContinueToOptions?: () => void
}

export function UploadPanel({
  shopSlug,
  shopName,
  initialDraft,
  maxFiles,
  maxPages,
  developmentStorage,
  onUploadChange,
  onContinueToOptions,
}: UploadPanelProps) {
  const [draft, setDraft] = useState<DraftView>(initialDraft)
  const [pending, setPending] = useState<PendingUpload[]>([])
  /** Refusals that belong to no row — a rejected intent, a dead shop, a lost connection. */
  const [problems, setProblems] = useState<{ id: string; message: string }[]>([])
  const [removing, startRemoving] = useTransition()
  const inputRef = useRef<HTMLInputElement>(null)
  /** Set on unmount so a late XHR callback cannot call `setState` on a dead component. */
  const alive = useRef(true)

  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  /*
   * Re-read the draft on mount.
   *
   * The page rendered the draft server-side already, but a customer who comes back with the
   * browser's back button gets that render from the client cache, and a file may have been
   * removed or expired since. One round trip buys the guarantee that what is on screen is
   * what the server actually holds.
   */
  useEffect(() => {
    let cancelled = false
    void readDraftAction({ shopSlug }).then((result) => {
      if (cancelled || !alive.current || !result.ok) return
      setDraft(result.data)
      onUploadChange?.(result.data)
    })
    return () => {
      cancelled = true
    }
  }, [shopSlug, onUploadChange])

  const complain = useCallback((message: string) => {
    setProblems((current) => [...current, { id: crypto.randomUUID(), message }])
  }, [])

  const dismiss = useCallback((id: string) => {
    setProblems((current) => current.filter((problem) => problem.id !== id))
  }, [])

  /** One file, all three steps. Resolves when the server has given its verdict. */
  const upload = useCallback(
    async (file: File) => {
      const localId = crypto.randomUUID()
      setPending((current) => [
        ...current,
        { localId, name: file.name, byteSize: file.size, percent: 0, phase: 'reserving' },
      ])

      const drop = () => setPending((current) => current.filter((item) => item.localId !== localId))
      const advance = (patch: Partial<PendingUpload>) =>
        setPending((current) =>
          current.map((item) => (item.localId === localId ? { ...item, ...patch } : item)),
        )

      const ticket = await beginUploadAction({
        shopSlug,
        filename: file.name,
        // `file.type` is the browser's guess and is often empty. The server treats it as a
        // hint and decides from the extension and, later, the bytes.
        declaredMime: file.type,
        byteSize: file.size,
      })

      if (!alive.current) return
      if (!ticket.ok) {
        // The refusal names the file the customer chose, because "File 3.pdf" means nothing
        // for a file that was never accepted and so never got a label.
        drop()
        complain(`${file.name} — ${ticket.message}`)
        return
      }

      advance({ phase: 'sending', percent: 0 })

      try {
        await putBytes(ticket.data.url, ticket.data.headers, file, (percent) => {
          if (alive.current) advance({ percent })
        })
      } catch (cause) {
        if (!alive.current) return
        drop()
        complain(
          `${file.name} — ${
            cause instanceof Error ? cause.message : 'The upload did not finish. Try again.'
          }`,
        )
        return
      }

      if (!alive.current) return
      // The bytes are gone but nothing is known about them yet. `null` progress and
      // "checking" is the truthful state; a tick here would be the fake success.
      advance({ phase: 'checking', percent: null })

      const finished = await completeUploadAction({ shopSlug, fileId: ticket.data.fileId })
      if (!alive.current) return

      drop()
      if (!finished.ok) {
        complain(`${file.name} — ${finished.message}`)
        return
      }
      setDraft(finished.data)
      onUploadChange?.(finished.data)
    },
    [complain, shopSlug, onUploadChange],
  )

  const onPick = useCallback(
    (files: FileList | null) => {
      if (!files) return
      // Sequential, not parallel: a phone on 3G uploading four files at once finishes all
      // four slowly and shows four crawling bars. One at a time finishes the first quickly.
      void Array.from(files).reduce(
        (chain, file) => chain.then(() => upload(file)),
        Promise.resolve(),
      )
      if (inputRef.current) inputRef.current.value = ''
    },
    [upload],
  )

  const remove = useCallback(
    (fileId: string) => {
      startRemoving(async () => {
        const result = await removeFileAction({ shopSlug, fileId })
        if (!alive.current) return
        if (!result.ok) {
          complain(result.message)
          return
        }
        setDraft(result.data)
        onUploadChange?.(result.data)
      })
    },
    [complain, shopSlug, onUploadChange],
  )

  const ready = draft.files.filter((file) => file.state === 'ready')
  const busy = pending.length > 0
  const atFileLimit = maxFiles !== null && draft.totals.files >= maxFiles

  return (
    <div className="space-y-4">
      {developmentStorage ? (
        <Notice tone="warn" title="Development storage">
          Files are being written to a local disk on this machine, not to object storage. This
          is a development build.
        </Notice>
      ) : null}

      {problems.map((problem) => (
        <Notice
          key={problem.id}
          tone="danger"
          action={
            <IconButton
              size="sm"
              variant="ghost"
              label="Dismiss"
              onClick={() => dismiss(problem.id)}
            >
              <X className="size-4" aria-hidden />
            </IconButton>
          }
        >
          {problem.message}
        </Notice>
      ))}

      <ul className="space-y-2.5">
        {draft.files.map((file) => (
          <li key={file.id}>
            <DraftFileRow file={file} onRemove={() => remove(file.id)} disabled={removing} />
          </li>
        ))}
        {pending.map((item) => (
          <li key={item.localId}>
            <PendingRow item={item} />
          </li>
        ))}
      </ul>

      <input
        ref={inputRef}
        type="file"
        multiple
        accept={ACCEPT_ATTRIBUTE}
        className="sr-only"
        onChange={(event) => onPick(event.target.files)}
      />

      <Button
        variant={draft.files.length === 0 && !busy ? 'primary' : 'secondary'}
        size="lg"
        block
        loading={busy}
        disabled={atFileLimit}
        onClick={() => inputRef.current?.click()}
      >
        <Plus className="size-4" aria-hidden />
        {draft.files.length === 0 ? `Choose files to print at ${shopName}` : 'Add another file'}
      </Button>

      {atFileLimit ? (
        <p className="text-center text-xs text-ink-3">
          This shop accepts {maxFiles} files per order. Remove one to add another.
        </p>
      ) : null}

      <DraftSummary draft={draft} readyCount={ready.length} maxFiles={maxFiles} maxPages={maxPages} />

      {/*
        The bar lives inside the panel rather than on the page because it reports the draft's
        live state. Rendered server-side it would still say "add at least one file" after a
        successful upload, which is the kind of small lie that makes a flow untrustworthy.
      */}
      <StickyActionBar
        secondary={
          ready.length === 0 ? (
            <p className="text-xs text-ink-3">
              {busy ? 'Checking your file…' : 'Add at least one file to continue'}
            </p>
          ) : (
            <p className="text-xs text-ink-3">
              {ready.length} {ready.length === 1 ? 'file' : 'files'} ready · next: how to print it
            </p>
          )
        }
      >
        {/*
          Disabled, not a link. C-08 does not exist yet, and a button that navigates to a 404
          would be worse than one that is honestly not ready.
        */}
        <Button
          type="button"
          variant="primary"
          size="md"
          disabled={!ready.length || !!busy}
          onClick={() => onContinueToOptions?.()}
        >
          Choose print options
        </Button>
      </StickyActionBar>
    </div>
  )
}

/** A file the server has an opinion about. */
function DraftFileRow({
  file,
  onRemove,
  disabled,
}: {
  file: DraftFile
  onRemove: () => void
  disabled: boolean
}) {
  const rejected = file.state === 'rejected'

  return (
    <Card variant={rejected ? 'outline' : 'plain'} padding="sm" className="flex items-start gap-3">
      <span
        className={cn(
          'mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg',
          rejected ? 'bg-danger-tint text-danger' : 'bg-paper-sunk text-ink-3',
        )}
        aria-hidden
      >
        {rejected ? <AlertTriangle className="size-4" /> : <FileText className="size-4" />}
      </span>

      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 gap-y-1">
          {/* The server's label, never the customer's filename — that stays encrypted. */}
          <span className="font-mono text-sm text-ink">{file.safeLabel}</span>
          <StateBadge file={file} />
        </div>

        <p className="mt-0.5 text-xs text-ink-3">
          {formatBytes(file.byteSize)}
          {file.pageCount !== null ? (
            <>
              {' · '}
              {file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'}
              {/* Said plainly: an unreliable count is why the price may need a quote. */}
              {file.pageCountReliable ? '' : ' (estimated)'}
            </>
          ) : null}
          {file.dominantPageSize ? ` · ${file.dominantPageSize}` : null}
          {file.hasMixedPageSizes ? ' · mixed sizes' : null}
        </p>

        {file.rejectionMessage ? (
          <p className="mt-1.5 text-xs leading-relaxed text-danger">{file.rejectionMessage}</p>
        ) : null}
      </div>

      <IconButton
        size="sm"
        variant="ghost"
        label={`Remove ${file.safeLabel}`}
        onClick={onRemove}
        disabled={disabled}
      >
        <Trash2 className="size-4" aria-hidden />
      </IconButton>
    </Card>
  )
}

function StateBadge({ file }: { file: DraftFile }) {
  if (file.state === 'ready') {
    return (
      <Badge tone="success" size="sm">
        <CheckCircle2 className="size-3" aria-hidden />
        Ready
      </Badge>
    )
  }
  if (file.state === 'rejected') {
    return (
      <Badge tone="danger" size="sm">
        Cannot print
      </Badge>
    )
  }
  // `reserved`, `uploading`, `scanning`, `processing` — all "not finished", and none of
  // them mean the file is usable.
  return (
    <Badge tone="neutral" size="sm">
      <Loader2 className="size-3 animate-spin-slow" aria-hidden />
      Checking
    </Badge>
  )
}

/** A file mid-flight. The one row that shows the customer's own filename. */
function PendingRow({ item }: { item: PendingUpload }) {
  const label =
    item.phase === 'reserving'
      ? 'Preparing'
      : item.phase === 'sending'
        ? `Uploading ${item.percent ?? 0}%`
        : 'Checking the file'

  return (
    <Card variant="sunk" padding="sm" className="flex items-start gap-3">
      <span className="mt-0.5 grid size-9 shrink-0 place-items-center rounded-lg bg-paper text-ink-3" aria-hidden>
        <RefreshCw className="size-4 animate-spin-slow" />
      </span>
      <div className="min-w-0 flex-1">
        <p className="truncate text-sm text-ink">{item.name}</p>
        <p className="mt-0.5 text-xs text-ink-3">
          {formatBytes(item.byteSize)} · {label}
        </p>
        <div
          className="mt-2 h-1 overflow-hidden rounded-full bg-paper-sunk"
          role="progressbar"
          aria-label={`Uploading ${item.name}`}
          {...(item.percent === null ? {} : { 'aria-valuenow': item.percent })}
        >
          <div
            className={cn(
              'h-full rounded-full bg-chaap transition-[width] duration-200',
              // Indeterminate once the bytes are sent: the server is checking and there is
              // no honest percentage for that.
              item.percent === null && 'animate-pulse',
            )}
            style={{ width: item.percent === null ? '100%' : `${item.percent}%` }}
          />
        </div>
      </div>
    </Card>
  )
}

function DraftSummary({
  draft,
  readyCount,
  maxFiles,
  maxPages,
}: {
  draft: DraftView
  readyCount: number
  maxFiles: number | null
  maxPages: number | null
}) {
  if (draft.files.length === 0) return null

  return (
    <p className="text-center text-xs text-ink-3">
      {readyCount} of {draft.totals.files} {draft.totals.files === 1 ? 'file' : 'files'} ready
      {maxFiles !== null ? ` (max ${maxFiles})` : ''} · {formatBytes(draft.totals.bytes)}
      {draft.totals.pages > 0 ? (
        <>
          {' · '}
          {draft.totals.pages} {draft.totals.pages === 1 ? 'page' : 'pages'}
          {maxPages !== null ? ` of ${maxPages}` : ''}
        </>
      ) : null}
    </p>
  )
}

/**
 * PUT the bytes, reporting progress.
 *
 * Rejects with a message the panel can show. The distinction that matters is 403: the
 * credential is per-key and expires, so an expired one means "start this file again", which
 * is what the message says rather than "forbidden".
 */
function putBytes(
  url: string,
  headers: Record<string, string>,
  file: File,
  onProgress: (percent: number) => void,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest()
    request.open('PUT', url, true)
    for (const [name, value] of Object.entries(headers)) {
      request.setRequestHeader(name, value)
    }

    request.upload.onprogress = (event) => {
      if (event.lengthComputable && event.total > 0) {
        onProgress(Math.min(99, Math.round((event.loaded / event.total) * 100)))
      }
    }

    request.onload = () => {
      if (request.status >= 200 && request.status < 300) {
        onProgress(100)
        resolve()
        return
      }
      if (request.status === 403) {
        reject(new Error('The upload link expired before the file finished. Add it again.'))
        return
      }
      if (request.status === 413) {
        reject(new Error('That file is larger than this shop accepts.'))
        return
      }
      reject(new Error(`Storage refused the upload (${request.status}). Try again.`))
    }

    // No status code at all: DNS, CORS, offline, or the tab lost the network. Not the
    // server's answer, so it must not be reported as one.
    request.onerror = () => reject(new Error('The connection dropped while uploading.'))
    request.onabort = () => reject(new Error('The upload was cancelled.'))

    request.send(file)
  })
}

'use client'

import { useState } from 'react'
import { ChevronLeft } from 'lucide-react'

import { Button } from '@/components/ui/button'
import { Card, CardHeader } from '@/components/ui/card'
import { StickyActionBar } from '@/components/shell/sticky-action-bar'
import { cn } from '@/lib/cn'

import type { DraftFile } from '@/server/domains/files/model'
import type { ShopCatalogue } from '@/server/domains/pricing/model'

/**
 * Configuration for one file: what size, colour, binding, etc.
 *
 * This lives in state while the customer configures, then gets passed to the pricing
 * engine. It mirrors `QuoteItemRequest` (minus `fileId` and `ref` which are set on POST).
 */
export interface FileConfiguration {
  fileId: string
  paperSizeCode: string
  colourMode: 'bw' | 'colour'
  sides: 'single' | 'double'
  copies: number
  finishings: Array<{ code: string; quantity?: number }>
}

export interface ConfigurePanelProps {
  files: DraftFile[]
  catalogue: ShopCatalogue
  onContinue: (configs: FileConfiguration[]) => void
  onBack: () => void
  calculating?: boolean
  error?: string | null
}

export function ConfigurePanel({ files, catalogue, onContinue, onBack, calculating = false, error }: ConfigurePanelProps) {
  const [configs, setConfigs] = useState<FileConfiguration[]>(
    files.map((file) => ({
      fileId: file.id,
      paperSizeCode: catalogue.paperSizes[0] || 'A4',
      colourMode: 'bw',
      sides: 'single',
      copies: 1,
      finishings: [],
    })),
  )

  const updateConfig = (fileId: string, patch: Partial<FileConfiguration>) => {
    setConfigs((current) =>
      current.map((c) => (c.fileId === fileId ? { ...c, ...patch } : c)),
    )
  }

  const toggleFinishing = (fileId: string, code: string) => {
    updateConfig(fileId, {
      finishings: configs
        .find((c) => c.fileId === fileId)
        ?.finishings.some((f) => f.code === code)
        ? configs
            .find((c) => c.fileId === fileId)
            ?.finishings.filter((f) => f.code !== code) || []
        : [
            ...(configs.find((c) => c.fileId === fileId)?.finishings || []),
            { code },
          ],
    })
  }

  // Paper sizes available from the catalogue
  const paperSizes = catalogue.paperSizes
  // Print options available (B&W and Colour if there are colour items)
  const hasColour = catalogue.items.some((item) => item.colourMode === 'colour')
  // Finishings available
  const availableFinishings = catalogue.items.filter((item) => item.kind === 'finishing')

  return (
    <div className="space-y-6 pb-2">
      <header className="px-4 pt-4">
        <button
          onClick={onBack}
          className="inline-flex items-center gap-1 text-sm text-ink-3 transition-colors hover:text-ink"
        >
          <ChevronLeft className="size-4" aria-hidden />
          Back to files
        </button>
        <h1 className="mt-2 font-display text-3xl leading-tight text-ink">How to print it</h1>
        <p className="mt-1 text-sm leading-relaxed text-ink-2">
          Choose your paper size, colour, and any finishing. Options shown are what {catalogue.shopSlug} offers.
        </p>
      </header>

      <div className="space-y-6 px-4">
        {configs.map((config) => {
          const file = files.find((f) => f.id === config.fileId)
          if (!file) return null

          return (
            <Card key={config.fileId} className="overflow-hidden">
              <CardHeader>
                <div className="flex items-baseline justify-between">
                  <div>
                    <p className="font-medium text-ink">{file.safeLabel}</p>
                    <p className="text-sm text-ink-2">
                      {file.pageCount} {file.pageCount === 1 ? 'page' : 'pages'} · {file.extension.toUpperCase()}
                    </p>
                  </div>
                </div>
              </CardHeader>

              <div className="space-y-4 px-4 pb-4">
                {/* Paper Size */}
                <div>
                  <label className="text-sm font-medium text-ink">Paper size</label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    {paperSizes.map((size) => (
                      <button
                        key={size}
                        onClick={() => updateConfig(config.fileId, { paperSizeCode: size })}
                        className={cn(
                          'rounded-full border px-3 py-1 text-sm font-medium transition-all',
                          config.paperSizeCode === size
                            ? 'border-primary bg-primary text-white'
                            : 'border-ink-3 bg-white text-ink hover:border-ink',
                        )}
                      >
                        {size}
                      </button>
                    ))}
                  </div>
                </div>

                {/* Colour Mode */}
                <div>
                  <label className="text-sm font-medium text-ink">Print colour</label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => updateConfig(config.fileId, { colourMode: 'bw' })}
                      className={cn(
                        'rounded-full border px-3 py-1 text-sm font-medium transition-all',
                        config.colourMode === 'bw'
                          ? 'border-primary bg-primary text-white'
                          : 'border-ink-3 bg-white text-ink hover:border-ink',
                      )}
                    >
                      B&W
                    </button>
                    {hasColour ? (
                      <button
                        onClick={() => updateConfig(config.fileId, { colourMode: 'colour' })}
                        className={cn(
                          'rounded-full border px-3 py-1 text-sm font-medium transition-all',
                          config.colourMode === 'colour'
                            ? 'border-primary bg-primary text-white'
                            : 'border-ink-3 bg-white text-ink hover:border-ink',
                        )}
                      >
                        Colour
                      </button>
                    ) : null}
                  </div>
                </div>

                {/* Sides */}
                <div>
                  <label className="text-sm font-medium text-ink">Sides</label>
                  <div className="mt-2 flex flex-wrap gap-2">
                    <button
                      onClick={() => updateConfig(config.fileId, { sides: 'single' })}
                      className={cn(
                        'rounded-full border px-3 py-1 text-sm font-medium transition-all',
                        config.sides === 'single'
                          ? 'border-primary bg-primary text-white'
                          : 'border-ink-3 bg-white text-ink hover:border-ink',
                      )}
                    >
                      Single
                    </button>
                    <button
                      onClick={() => updateConfig(config.fileId, { sides: 'double' })}
                      className={cn(
                        'rounded-full border px-3 py-1 text-sm font-medium transition-all',
                        config.sides === 'double'
                          ? 'border-primary bg-primary text-white'
                          : 'border-ink-3 bg-white text-ink hover:border-ink',
                      )}
                    >
                      Double
                    </button>
                  </div>
                </div>

                {/* Copies */}
                <div>
                  <label className="text-sm font-medium text-ink">Number of copies</label>
                  <div className="mt-2 flex items-center gap-2">
                    <input
                      type="number"
                      min="1"
                      max="500"
                      value={config.copies}
                      onChange={(e) =>
                        updateConfig(config.fileId, { copies: Math.max(1, parseInt(e.target.value) || 1) })
                      }
                      className="w-20 rounded border border-ink-3 px-2 py-1 text-sm"
                    />
                    <span className="text-sm text-ink-2">copies</span>
                  </div>
                </div>

                {/* Finishing */}
                {availableFinishings.length > 0 ? (
                  <div>
                    <label className="text-sm font-medium text-ink">Finishing (optional)</label>
                    <div className="mt-2 space-y-2">
                      {availableFinishings.map((finishing) => (
                        <button
                          key={finishing.code}
                          onClick={() => toggleFinishing(config.fileId, finishing.code)}
                          className={cn(
                            'block w-full rounded border px-3 py-2 text-left text-sm transition-all',
                            config.finishings.some((f) => f.code === finishing.code)
                              ? 'border-primary bg-primary/10 text-primary'
                              : 'border-ink-3 bg-white text-ink hover:border-ink',
                          )}
                        >
                          <span className="font-medium">{finishing.shortName}</span>
                          <span className="ml-2 text-xs text-ink-2">{finishing.name}</span>
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            </Card>
          )
        })}
      </div>

      <StickyActionBar
        secondary={
          error ? (
            <p className="text-xs text-danger">{error}</p>
          ) : (
            <p className="text-xs text-ink-3">
              {configs.length} {configs.length === 1 ? 'file' : 'files'} · Next: see the price
            </p>
          )
        }
      >
        <Button
          variant="primary"
          size="md"
          onClick={() => onContinue(configs)}
          loading={calculating}
          disabled={calculating}
        >
          Continue to price
        </Button>
      </StickyActionBar>
    </div>
  )
}

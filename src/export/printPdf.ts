// Prints a PDF Blob (Story 8.4): the PDF goes into a hidden iframe and only that iframe is printed, so no app UI
// reaches the preview. Resolves once the print dialog was asked for; the iframe and URL go away after printing.
const CLEANUP_MS = 120_000 // shortcut: some browsers never fire afterprint for a PDF viewer; this bounds the leak

export function printBlob(blob: Blob): Promise<void> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob)
    const frame = document.createElement('iframe')
    frame.setAttribute('aria-hidden', 'true')
    frame.tabIndex = -1
    frame.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden'
    let timer: ReturnType<typeof setTimeout> | undefined
    const cleanup = () => {
      clearTimeout(timer)
      frame.remove()
      URL.revokeObjectURL(url)
    }
    frame.onload = () => {
      try {
        const w = frame.contentWindow!
        w.addEventListener('afterprint', cleanup)
        timer = setTimeout(cleanup, CLEANUP_MS)
        w.focus()
        w.print()
        resolve()
      } catch (e) {
        cleanup()
        reject(e)
      }
    }
    frame.onerror = () => (cleanup(), reject(new Error('print frame failed')))
    frame.src = url
    document.body.appendChild(frame)
  })
}

/** Sidebar icon for the Research main panel. */
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * Render the Research notebook glyph.
 * @param props - sidebar list seat size and active state.
 * @returns the icon.
 */
export function ResearchPanelIcon({ size, active }: PropsRuntime<'sidebar.panellist'>) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={active ? 2.1 : 1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M5 4.5h9.5A2.5 2.5 0 0 1 17 7v13H7.5A2.5 2.5 0 0 1 5 17.5z" />
      <path d="M8.5 8h5M8.5 11.5h5M8.5 15h3" />
      <path d="M17 7h2v13h-2" />
    </svg>
  )
}

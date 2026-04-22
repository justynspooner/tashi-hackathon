// Pulsing primary-coloured ring drawn around the currently-selected entity
// on the canvas. Rendered as a small SVG subtree so it lives inside the
// zoom layer (selection ring zooms and pans with the field).

interface Props {
  x: number
  y: number
}

export function SelectionRing({ x, y }: Props) {
  return (
    <g
      className="pointer-events-none"
      transform={`translate(${x}, ${y})`}
      aria-hidden
    >
      <circle
        r={20}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={2.5}
        strokeOpacity={0.95}
      >
        <animate
          attributeName="r"
          values="18;24;18"
          dur="1.6s"
          repeatCount="indefinite"
        />
        <animate
          attributeName="stroke-opacity"
          values="0.55;0.95;0.55"
          dur="1.6s"
          repeatCount="indefinite"
        />
      </circle>
      <circle
        r={26}
        fill="none"
        stroke="var(--primary)"
        strokeWidth={1}
        strokeOpacity={0.4}
      />
    </g>
  )
}

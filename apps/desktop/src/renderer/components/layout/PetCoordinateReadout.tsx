import './PetCoordinateReadout.css'

export function PetCoordinateReadout({ text }: { text: string }): React.JSX.Element {
  return <output className="ui-pet-coordinate-readout" aria-live="polite">{text}</output>
}

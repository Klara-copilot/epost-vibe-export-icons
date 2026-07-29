export type Step = 'settings' | 'search' | 'export' | 'deploy';

const STEPS: { id: Step; label: string }[] = [
  { id: 'settings', label: '1. Settings' },
  { id: 'search', label: '2. Search & Register' },
  { id: 'export', label: '3. Export' },
  { id: 'deploy', label: '4. Deploy' },
];

export function StepNav({
  current,
  onSelect,
}: {
  current: Step;
  onSelect: (step: Step) => void;
}) {
  return (
    <nav className="step-nav">
      {STEPS.map((step) => (
        <button
          key={step.id}
          className={step.id === current ? 'step-nav__item step-nav__item--active' : 'step-nav__item'}
          onClick={() => onSelect(step.id)}
        >
          {step.label}
        </button>
      ))}
    </nav>
  );
}

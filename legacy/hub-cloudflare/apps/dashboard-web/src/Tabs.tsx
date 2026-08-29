interface TabItem<T extends string> {
  value: T;
  label: string;
}

interface TabsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  items: TabItem<T>[];
  className?: string;
}

export function Tabs<T extends string>({ value, onChange, items, className }: TabsProps<T>) {
  return (
    <nav
      className={className ? `tabs ${className}` : 'tabs'}
      role="tablist"
      aria-label="Main sections"
    >
      {items.map((it) => (
        <button
          key={it.value}
          type="button"
          role="tab"
          aria-selected={value === it.value}
          className={value === it.value ? 'tab active' : 'tab'}
          onClick={() => onChange(it.value)}
        >
          {it.label}
        </button>
      ))}
    </nav>
  );
}

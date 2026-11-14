type TabButtonProps = {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
  icon?: React.ComponentType<{ className?: string }>;
};

export const TabButton = ({ active, onClick, icon: Icon, children }: TabButtonProps) => {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      onClick={onClick}
      className={`px-6 py-3 -mb-px border-b-2 font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-t-md ${
        active
          ? 'border-primary text-primary font-semibold'
          : 'border-transparent text-muted-foreground hover:text-foreground hover:bg-muted/60'
      }`}
    >
      {Icon && <Icon className="w-4 h-4 inline mr-2" />}
      {children}
    </button>
  );
};

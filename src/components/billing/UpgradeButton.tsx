// The Upgrade button is removed in this build: the app is local-only with
// no paid plan, so the billing upsell goes away. The export and its props
// type are kept exactly, so every call site (EditorHeader, Dashboard,
// AccountPlanCard, CloudUsageCard) compiles unchanged — it just renders
// nothing.
export function UpgradeButton(_props: {
	className?: string;
	label?: string;
	showDiscount?: boolean;
	truncateLabel?: boolean;
	variant?: "primary" | "secondary" | "ghost";
	size?: "sm" | "md" | "lg";
}): null {
	return null;
}

import type { ButtonHTMLAttributes, ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import "./ui.css";

export type ButtonVariant = "primary" | "secondary" | "ghost";

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  variant?: ButtonVariant;
  loading?: boolean;
}

export function Button({
  children,
  className = "",
  variant = "secondary",
  loading = false,
  disabled,
  ...props
}: ButtonProps) {
  const classes = ["ui-button", `ui-button--${variant}`, className].filter(Boolean).join(" ");

  return (
    <button className={classes} disabled={disabled || loading} {...props}>
      {loading ? <LoaderCircle aria-hidden="true" className="ui-button__spinner" size={15} /> : null}
      <span>{children}</span>
    </button>
  );
}

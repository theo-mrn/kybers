"use client";

import * as React from "react";
import { useState } from "react";
import { Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

/**
 * Bouton dont l'action passe par une confirmation.
 *
 * Pour les gestes déclenchés hors formulaire — où `SubmitButton` ne s'applique
 * pas. `window.confirm` bloque le navigateur, ne peut pas être stylé et
 * n'expose pas la portée réelle de l'action.
 */
export function ConfirmButton({
  onConfirm,
  title,
  description,
  confirmLabel = "Confirmer",
  variant = "ghost",
  size = "icon-sm",
  icon: Icon,
  label,
  ariaLabel,
  pending = false,
  disabled = false,
  className,
}: {
  onConfirm: () => void;
  title: string;
  description: string;
  confirmLabel?: string;
  variant?: "default" | "outline" | "secondary" | "ghost" | "destructive";
  size?: "default" | "sm" | "xs" | "lg" | "icon" | "icon-sm" | "icon-xs";
  icon?: React.ComponentType<{ className?: string }>;
  /** Absent pour un bouton icône seule. */
  label?: string;
  ariaLabel?: string;
  pending?: boolean;
  disabled?: boolean;
  className?: string;
}) {
  const [open, setOpen] = useState(false);

  return (
    <>
      <Button
        type="button"
        variant={variant}
        size={size}
        aria-label={ariaLabel}
        disabled={pending || disabled}
        className={className}
        onClick={() => setOpen(true)}
      >
        {pending ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : Icon ? (
          <Icon className="size-3.5" />
        ) : null}
        {label}
      </Button>

      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </DialogHeader>

          <DialogFooter>
            <Button
              type="button"
              variant="outline"
              onClick={() => setOpen(false)}
            >
              Annuler
            </Button>
            <Button
              type="button"
              variant={variant === "ghost" ? "destructive" : variant}
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              {Icon ? <Icon className="size-3.5" /> : null}
              {confirmLabel}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

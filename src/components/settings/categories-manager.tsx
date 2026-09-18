"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { createCategoryAction } from "@/server/settings/actions";
import type { Category } from "@/server/db/repositories/categories";

export function CategoriesManager({ organizationId, categories }: { organizationId: string; categories: Category[] }) {
  const [kind, setKind] = useState<"income" | "expense">("expense");
  const [state, formAction, pending] = useActionState(createCategoryAction, {});

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap gap-1.5">
        {categories.map((c) => (
          <Badge key={c.id} variant={c.kind === "income" ? "positive" : "neutral"}>
            {c.name}
          </Badge>
        ))}
      </div>

      <form action={formAction} className="flex items-end gap-2">
        <input type="hidden" name="organizationId" value={organizationId} />
        <input type="hidden" name="kind" value={kind} />
        <div className="flex flex-col gap-1.5">
          <Input name="name" placeholder="New category name" className="w-48" required />
        </div>
        <Select value={kind} onValueChange={(v) => setKind(v as "income" | "expense")}>
          <SelectTrigger className="w-32">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="expense">Expense</SelectItem>
            <SelectItem value="income">Income</SelectItem>
          </SelectContent>
        </Select>
        <Button type="submit" variant="secondary" disabled={pending}>
          Add
        </Button>
      </form>
      {state.error && <p className="text-[13px] text-negative">{state.error}</p>}
    </div>
  );
}

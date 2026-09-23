"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ErrorState } from "@/components/ui/error-state";
import { createClient } from "@/server/supabase/client";
import { confirmDocumentUpload, requestDocumentUpload } from "@/server/documents/actions";
import { MAX_UPLOAD_LABEL } from "@/domain/documents/upload-limits";

/**
 * Three steps, and the middle one does not touch the application.
 *
 *   1. `requestDocumentUpload` — the server authorizes, picks the object key,
 *      and returns a token scoped to that key.
 *   2. `uploadToSignedUrl` — the browser PUTs the bytes straight to Supabase
 *      Storage. This is why a 20 MB receipt no longer requires every Server
 *      Action in the product to accept a 20 MB body.
 *   3. `confirmDocumentUpload` — the server reads back what landed and decides
 *      whether it becomes a document.
 *
 * Nothing here is a security control. The file input's `accept`, and the fact
 * that step 3 is called at all, are conveniences: the server picks the path,
 * verifies the size and the leading bytes itself, and a client that skips
 * step 3 simply leaves a `pending` row that no product read will ever show.
 */
export function UploadDocumentDialog({ organizationId }: { organizationId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [file, setFile] = useState<File | null>(null);
  const [kind, setKind] = useState("receipt");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  function reset() {
    setFile(null);
    setError(null);
    setPending(false);
  }

  async function handleUpload() {
    if (!file || pending) return;
    setPending(true);
    setError(null);

    const requested = await requestDocumentUpload({
      organizationId,
      kind,
      originalFilename: file.name,
      mimeType: file.type,
      sizeBytes: file.size,
    });

    if (requested.error || !requested.upload) {
      setError(requested.error ?? "Couldn't start the upload.");
      setPending(false);
      return;
    }

    const { documentId, storagePath, token } = requested.upload;
    const supabase = createClient();
    const { error: uploadError } = await supabase.storage
      .from("documents")
      .uploadToSignedUrl(storagePath, token, file, { contentType: file.type });

    if (uploadError) {
      // The `pending` row stays behind and stays invisible. It is reclaimed by
      // the sweep rather than deleted from here, because a client that just
      // failed to reach Storage is not the thing to trust with cleanup.
      setError("The file couldn't be uploaded. Please check your connection and try again.");
      setPending(false);
      return;
    }

    const confirmed = await confirmDocumentUpload({ organizationId, documentId });
    if (confirmed.error) {
      setError(confirmed.error);
      setPending(false);
      return;
    }

    setOpen(false);
    reset();
    router.refresh();
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger asChild>
        <Button>Upload document</Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Upload document</DialogTitle>
        </DialogHeader>
        <div className="flex flex-col gap-4">
          {error && <ErrorState title="Couldn't upload" description={error} />}

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="kind">Type</Label>
            <Select value={kind} onValueChange={setKind}>
              <SelectTrigger id="kind">
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="receipt">Receipt</SelectItem>
                <SelectItem value="invoice">Invoice</SelectItem>
                <SelectItem value="bill">Bill</SelectItem>
                <SelectItem value="bank_statement">Bank statement</SelectItem>
                <SelectItem value="tax_form">Tax form (W-9, 1099, ...)</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>

          <div className="flex flex-col gap-1.5">
            <Label htmlFor="file">File</Label>
            <label
              htmlFor="file"
              className="flex h-24 cursor-pointer flex-col items-center justify-center gap-1 rounded-md border border-dashed border-border text-center transition-colors duration-100 ease-out hover:border-border-strong"
            >
              <span className="text-[13px] text-text-secondary">{file?.name ?? "Click to choose a PDF or image"}</span>
              <span className="text-[11px] text-text-tertiary">PDF, PNG, JPEG, WEBP — up to {MAX_UPLOAD_LABEL}</span>
              {/* WEBP is stored but has no reader (file-signature.ts), so the
                  difference is stated here rather than discovered after an
                  upload that never produces any figures. */}
              <span className="text-[11px] text-text-tertiary">Figures are read from PDF, PNG and JPEG</span>
            </label>
            <input
              id="file"
              name="file"
              type="file"
              accept="application/pdf,image/png,image/jpeg,image/webp"
              className="sr-only"
              onChange={(e) => setFile(e.target.files?.[0] ?? null)}
            />
          </div>

          <DialogFooter>
            <Button type="button" variant="ghost" onClick={() => setOpen(false)}>
              Cancel
            </Button>
            <Button type="button" onClick={handleUpload} disabled={pending || !file}>
              {pending ? "Uploading…" : "Upload"}
            </Button>
          </DialogFooter>
        </div>
      </DialogContent>
    </Dialog>
  );
}

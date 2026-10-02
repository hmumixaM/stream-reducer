import { useEffect, useId, useRef, useState } from "react";
import { ImagePlus, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui";

const MAX_IMAGES = 4;

export function FeedbackDialog({
  open,
  email,
  zh,
  onClose,
}: {
  open: boolean;
  email: string;
  zh: boolean;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const [kind, setKind] = useState<"bug" | "suggestion">("bug");
  const [body, setBody] = useState("");
  const [images, setImages] = useState<File[]>([]);
  const [previews, setPreviews] = useState<string[]>([]);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    dialog.setAttribute("closedby", "any");
    if (open && !dialog.open) dialog.showModal();
    if (!open && dialog.open) dialog.close();
  }, [open]);

  useEffect(() => {
    const urls = images.map((image) => URL.createObjectURL(image));
    setPreviews(urls);
    return () => urls.forEach((url) => URL.revokeObjectURL(url));
  }, [images]);

  const reset = () => {
    setKind("bug");
    setBody("");
    setImages([]);
    setError("");
    setSent(false);
    setPending(false);
  };

  const close = () => {
    reset();
    onClose();
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const note = body.trim();
    if (!note || pending) return;
    setPending(true);
    setError("");
    try {
      await api.sendFeedback({ kind, body: note, pageUrl: window.location.href, images });
      setSent(true);
    } catch {
      setError(zh ? "发送失败，请再试一次。" : "Could not send that. Please try again.");
      setPending(false);
    }
  };

  return (
    <dialog
      ref={dialogRef}
      aria-labelledby={titleId}
      className="w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-card p-0 text-card-foreground shadow-card backdrop:bg-black/50"
      onClose={close}
      onClick={(event) => {
        if (event.target === event.currentTarget) event.currentTarget.close();
      }}
    >
      <form onSubmit={submit} className="space-y-4 p-5">
        <div className="flex items-start justify-between gap-3">
          <h2 id={titleId} className="text-lg font-semibold">{zh ? "反馈" : "Feedback"}</h2>
          <button type="button" className="rounded-md p-1 text-muted-foreground hover:bg-accent" onClick={() => dialogRef.current?.close()} aria-label={zh ? "关闭" : "Close"}>
            <X className="h-4 w-4" />
          </button>
        </div>
        {sent ? (
          <p>{zh ? "已收到，谢谢。" : "Thanks, we received it."}</p>
        ) : (
          <>
            <fieldset className="flex gap-2">
              <legend className="sr-only">{zh ? "类型" : "Type"}</legend>
              {([
                ["bug", zh ? "报告问题" : "Report a bug"],
                ["suggestion", zh ? "提建议" : "Suggestion"],
              ] as const).map(([value, label]) => (
                <label key={value} className="flex-1 cursor-pointer">
                  <input
                    type="radio"
                    name="feedback-kind"
                    value={value}
                    checked={kind === value}
                    onChange={() => setKind(value)}
                    className="peer sr-only"
                  />
                  <span className="block rounded-md border border-border px-3 py-2 text-center text-sm peer-checked:border-primary peer-checked:bg-primary/10 peer-focus-visible:ring-2 peer-focus-visible:ring-ring">
                    {label}
                  </span>
                </label>
              ))}
            </fieldset>
            <label className="block text-sm">
              <span className="mb-1 block font-medium">{zh ? "说明" : "Note"}</span>
              <textarea
                required
                autoFocus
                rows={5}
                maxLength={4000}
                value={body}
                onChange={(event) => setBody(event.target.value)}
                className="w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm shadow-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              />
            </label>
            <div className="space-y-2">
              <label className="inline-flex cursor-pointer items-center gap-2 text-sm font-medium">
                <ImagePlus className="h-4 w-4" />
                {zh ? "上传图片" : "Add images"}
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/webp,image/gif"
                  multiple
                  className="sr-only"
                  onChange={(event) => {
                    const next = [...images, ...Array.from(event.target.files ?? [])].slice(0, MAX_IMAGES);
                    setImages(next);
                    event.target.value = "";
                  }}
                />
              </label>
              {previews.length > 0 && (
                <ul className="flex flex-wrap gap-2">
                  {previews.map((url, index) => (
                    <li key={url} className="relative">
                      <img src={url} alt="" className="h-16 w-16 rounded-md border border-border object-cover" />
                      <button
                        type="button"
                        className="absolute -right-1 -top-1 rounded-full bg-card p-0.5 shadow"
                        aria-label={zh ? "移除图片" : "Remove image"}
                        onClick={() => setImages(images.filter((_, imageIndex) => imageIndex !== index))}
                      >
                        <X className="h-3 w-3" />
                      </button>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p className="text-xs text-muted-foreground">{zh ? "将记录你的邮箱：" : "We'll record your email: "}{email}</p>
            {error && <p className="text-sm text-danger" role="alert">{error}</p>}
            <div className="flex justify-end gap-2">
              <Button type="button" variant="ghost" onClick={() => dialogRef.current?.close()}>{zh ? "取消" : "Cancel"}</Button>
              <Button type="submit" disabled={pending || !body.trim()}>{pending ? (zh ? "发送中…" : "Sending…") : (zh ? "发送" : "Send")}</Button>
            </div>
          </>
        )}
      </form>
    </dialog>
  );
}

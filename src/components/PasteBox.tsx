interface Props {
  text: string;
  onChange: (text: string) => void;
  onClose: () => void;
}

export function PasteBox({ text, onChange, onClose }: Props) {
  return (
    <div class="card">
      <div class="card-head">
        <h2>Text to translate</h2>
        <button type="button" class="btn btn-ghost" onClick={onClose}>
          Back to file upload
        </button>
      </div>
      <textarea
        class="paste-area"
        rows={12}
        placeholder="Paste the source text (Markdown is fine) and press “Translate only”."
        value={text}
        onInput={(e) => onChange((e.target as HTMLTextAreaElement).value)}
      />
      <p class="muted">{text.length.toLocaleString()} characters</p>
    </div>
  );
}

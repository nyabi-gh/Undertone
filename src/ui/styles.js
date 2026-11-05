export const STYLES = `
/* BetterDiscord pins its dropdown list to the opening button with anchor() but never sets
   position-anchor, which Chrome 152 defaults to normal; the list then falls to the corner. */
.mollu-settings .bd-select-options {
    position-anchor: auto;
}
.mollu-translation__anchor {
    display: block;
    height: 0;
    margin: 0;
    padding: 0;
    pointer-events: none;
    overflow-anchor: none;
}
.mollu-translation {
    overflow-anchor: none;
    contain: layout style;
    margin-top: 2px;
    color: var(--text-muted, #949ba4);
    font-size: 0.95rem;
    line-height: 1.375;
    white-space: pre-wrap;
    word-break: break-word;
}
.mollu-translation__badge {
    display: inline-block;
    margin-right: 6px;
    padding: 0 5px;
    border-radius: 4px;
    font-size: 0.68rem;
    font-weight: 700;
    letter-spacing: 0.04em;
    vertical-align: 1px;
    color: var(--text-muted, #949ba4);
    background: var(--background-modifier-accent, rgba(148, 155, 164, 0.16));
}
.mollu-translation__emoji {
    width: 1.375em;
    height: 1.375em;
    margin: 0 1px;
    object-fit: contain;
    vertical-align: -0.3em;
}
.mollu-translation__mention {
    padding: 0 2px;
    border-radius: 3px;
    color: var(--mention-foreground, #c9cdfb);
    background: var(--mention-background, rgba(88, 101, 242, 0.24));
}
.mollu-translation__code {
    padding: 0 3px;
    border-radius: 3px;
    font-family: var(--font-code, monospace);
    font-size: 0.85em;
    white-space: pre-wrap;
    background: var(--background-secondary, rgba(0, 0, 0, 0.2));
}
.mollu-md-h1,
.mollu-md-h2,
.mollu-md-h3,
.mollu-md-subtext,
.mollu-md-quote {
    display: block;
}
.mollu-md-h1 {
    font-size: 1.25em;
    font-weight: 700;
}
.mollu-md-h2 {
    font-size: 1.15em;
    font-weight: 700;
}
.mollu-md-h3 {
    font-size: 1.05em;
    font-weight: 700;
}
.mollu-md-subtext {
    font-size: 0.8em;
}
.mollu-md-quote {
    margin: 2px 0;
    padding-left: 10px;
    border-left: 3px solid var(--background-modifier-accent, rgba(148, 155, 164, 0.4));
}
.mollu-md-link {
    color: var(--text-link, #00a8fc);
    text-decoration: none;
}
.mollu-md-link:hover {
    text-decoration: underline;
}
.mollu-md-spoiler {
    padding: 0 2px;
    border-radius: 3px;
    color: transparent;
    background: var(--spoiler-hidden-background, #1e1f22);
    cursor: pointer;
}
.mollu-md-spoiler > * {
    opacity: 0;
}
.mollu-md-spoiler:focus-visible {
    outline: 2px solid var(--focus-primary, #00a8fc);
}
.mollu-md-spoiler--shown {
    color: inherit;
    background: var(--spoiler-revealed-background, rgba(148, 155, 164, 0.16));
    cursor: auto;
}
.mollu-md-spoiler--shown > * {
    opacity: 1;
}
.mollu-translation__trigger {
    display: inline-block;
    margin-top: 2px;
    padding: 0;
    border: none;
    background: none;
    font-size: 0.8rem;
    font-family: inherit;
    line-height: 1.2;
    color: var(--text-muted, #949ba4);
    opacity: 0.75;
    cursor: pointer;
}
.mollu-translation__trigger:hover {
    opacity: 1;
    text-decoration: underline;
}
.mollu-translation--pending {
    opacity: 0.6;
    font-style: italic;
}
.mollu-translation--error {
    display: block;
    padding: 0;
    border: none;
    background: none;
    font-family: inherit;
    font-size: 0.8rem;
    text-align: left;
    color: var(--text-danger, #f23f43);
    opacity: 0.8;
    cursor: pointer;
}
.mollu-translation--error:hover,
.mollu-translation--error:focus-visible {
    opacity: 1;
    text-decoration: underline;
}
`;

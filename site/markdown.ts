// The markdown subset prreceipt writes (headings, lists, tables, italic notes, quotes, <sub>), as GitHub shows
// it. Used by the website's sample receipt and by `npm run screenshots`. Everything is HTML-escaped first, so
// branch or model names can't inject markup.

export const escapeHtml = (s: string): string =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const inline = (s: string): string =>
  escapeHtml(s)
    .replace(/`([^`]*)`/g, '<code>$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');

export function markdownToHtml(md: string): string {
  const html: string[] = [];
  for (const block of md.trim().split(/\n{2,}/)) {
    const lines = block.split('\n').filter((l) => !/^<!--.*-->$/.test(l));
    if (lines.length === 0) continue;
    const first = lines[0];
    if (first.startsWith('## ')) html.push(`<h2>${inline(first.slice(3))}</h2>`);
    else if (first.startsWith('### ')) html.push(`<h3>${inline(first.slice(4))}</h3>`);
    else if (first.startsWith('- ')) html.push(`<ul>${lines.map((l) => `<li>${inline(l.slice(2))}</li>`).join('')}</ul>`);
    else if (first.startsWith('|')) {
      const cells = (l: string) => l.split('|').slice(1, -1).map((c) => c.trim());
      const right = cells(lines[1] ?? '').map((c) => c.endsWith(':'));
      const row = (l: string, tag: string) =>
        `<tr>${cells(l).map((c, i) => `<${tag}${right[i] ? ' class="r"' : ''}>${inline(c)}</${tag}>`).join('')}</tr>`;
      html.push(`<div class="scroll"><table><thead>${row(first, 'th')}</thead><tbody>${lines.slice(2).map((l) => row(l, 'td')).join('')}</tbody></table></div>`);
    } else if (first.startsWith('> ')) html.push(`<blockquote>${inline(lines.map((l) => l.slice(2)).join(' '))}</blockquote>`);
    else if (/^<sub>.*<\/sub>$/.test(first)) html.push(`<p><sub>${inline(first.slice(5, -6))}</sub></p>`);
    else if (/^_.*_$/.test(first)) html.push(`<p><em>${inline(first.slice(1, -1))}</em></p>`);
    else html.push(`<p>${inline(lines.join(' '))}</p>`);
  }
  return html.join('\n');
}

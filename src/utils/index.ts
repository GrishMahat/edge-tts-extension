export const cleanText = (text: string): string => {
  if (!text) return '';

  return text
    // Remove fenced code blocks
    .replace(/```[\s\S]*?```/g, ' ')

    // Remove inline code
    .replace(/`[^`]+`/g, ' ')

    // Convert markdown links to visible text
    .replace(/\[([^\]]+)\]\([^)]+\)/g, '$1')

    // Remove raw URLs
    .replace(/https?:\/\/\S+/g, ' ')

    // Remove emails
    .replace(/\b[\w.-]+@[\w.-]+\.\w+\b/g, ' ')

    // Strip HTML tags
    .replace(/<\/?[^>]+>/g, ' ')

    // Remove leading line numbers
    .replace(/^\s*\d+\s+/gm, ' ')

    // Remove programming punctuation clusters
    .replace(/[{}[\]();=<>*/%]+/g, ' ')

    // Remove common programming keywords
    // .replace(/\b(const|let|var|function)\b/g, ' ')


    // Collapse whitespace once, at the end
    .replace(/\s+/g, ' ')
    .trim();
};

/**
 * 严格模板渲染器: 确保每个 {{TOKEN}} 占位符被精确替换, 不留未定义或遗漏占位。
 */

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const GO_FORMAT_RE = /\{\{\.[A-Za-z0-9_.]+\}\}/g;
const LEFTOVER_BRACE_RE = /\{\{|\}\}/;

export const renderTemplate = (
  templateName: string,
  rawTemplate: string,
  vars: Record<string, string | number>,
): string => {
  const missing = new Set<string>();
  const rendered = rawTemplate.replace(TOKEN_RE, (_full, key: string) => {
    const val = vars[key];
    if (val === undefined || val === null) {
      missing.add(key);
      return `{{${key}}}`;
    }
    return String(val);
  });

  if (missing.size > 0) {
    throw new TemplateRenderError(
      `模板 ${templateName} 缺少以下必填变量: ${[...missing].join(', ')}`,
    );
  }
  const withoutGoFmt = rendered.replace(GO_FORMAT_RE, '');
  if (LEFTOVER_BRACE_RE.test(withoutGoFmt)) {
    throw new TemplateRenderError(
      `模板 ${templateName} 渲染后仍残留花括号标记 ({{ 或 }}), 请检查模板语法或变量值`,
    );
  }
  return rendered;
};

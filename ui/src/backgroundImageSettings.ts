import defaults from './background-image-defaults.json';

export type BackgroundImageSettings = typeof defaults;

const orders = new Set(['随机', '顺序']);
const alignments = new Set(['左上', '顶部居中', '右上', '左侧居中', '居中', '右侧居中', '左下', '底部居中', '右下']);
const repeats = new Set(['不重复', '重复', '水平重复', '垂直重复']);
const sizes = new Set(['覆盖', '包含', '原始大小']);

function numeric(value: unknown, fallback: number, minimum: number, maximum: number) {
  const parsed = value == null || value === '' ? Number.NaN : Number(value);
  return Number.isFinite(parsed) ? Math.min(maximum, Math.max(minimum, parsed)) : fallback;
}

export function resolveBackgroundImageSettings(config: Record<string, any>): BackgroundImageSettings {
  return {
    background_images_enabled: typeof config.background_images_enabled === 'boolean' ? config.background_images_enabled : defaults.background_images_enabled,
    background_images_directory: typeof config.background_images_directory === 'string' ? config.background_images_directory : defaults.background_images_directory,
    background_images_order: orders.has(config.background_images_order) ? config.background_images_order : defaults.background_images_order,
    background_images_alignment: alignments.has(config.background_images_alignment) ? config.background_images_alignment : defaults.background_images_alignment,
    background_images_blur: numeric(config.background_images_blur, defaults.background_images_blur, 0, 40),
    background_images_opacity: numeric(config.background_images_opacity, defaults.background_images_opacity, 0, 1),
    background_images_foreground_opacity: numeric(config.background_images_foreground_opacity, defaults.background_images_foreground_opacity, 0.05, 1),
    background_images_repeat: repeats.has(config.background_images_repeat) ? config.background_images_repeat : defaults.background_images_repeat,
    background_images_size: sizes.has(config.background_images_size) ? config.background_images_size : defaults.background_images_size,
    background_images_interval: numeric(config.background_images_interval, defaults.background_images_interval, 1, 3600),
  };
}

import React from 'react';
import { api, BackgroundImageEntry } from '../api';
import { resolveBackgroundImageSettings } from '../backgroundImageSettings';

type Props = { config: Record<string, any>; children: React.ReactNode };
type ImageLayer = { dataUrl: string; path: string; visible: boolean };
const emptyLayer: ImageLayer = { dataUrl: '', path: '', visible: false };

const alignmentMap: Record<string, string> = {
  '左上': 'left top', '顶部居中': 'center top', '右上': 'right top',
  '左侧居中': 'left center', '居中': 'center center', '右侧居中': 'right center',
  '左下': 'left bottom', '底部居中': 'center bottom', '右下': 'right bottom',
};
const repeatMap: Record<string, string> = { '不重复': 'no-repeat', '重复': 'repeat', '水平重复': 'repeat-x', '垂直重复': 'repeat-y' };
const sizeMap: Record<string, string> = { '覆盖': 'cover', '包含': 'contain', '原始大小': 'auto' };

export function BackgroundLayer({ config, children }: Props) {
  const settings = resolveBackgroundImageSettings(config);
  const enabled = settings.background_images_enabled;
  const directory = settings.background_images_directory;
  const order = settings.background_images_order;
  const [images, setImages] = React.useState<BackgroundImageEntry[]>([]);
  const [index, setIndex] = React.useState(0);
  const [layers, setLayers] = React.useState<[ImageLayer, ImageLayer]>([emptyLayer, emptyLayer]);
  const activeLayerRef = React.useRef<0 | 1>(0);
  const failedImagesRef = React.useRef(new Set<string>());
  const orderRef = React.useRef(order);
  orderRef.current = order;

  React.useEffect(() => {
    let cancelled = false;
    failedImagesRef.current.clear();
    setImages([]);
    setIndex(0);
    if (!enabled || !directory) { setLayers([emptyLayer, emptyLayer]); return undefined; }
    void api.backgroundImages.list(directory).then((result) => {
      if (cancelled) return;
      setImages(result.images || []);
      setIndex((result.images || []).length > 1 && orderRef.current === '随机' ? Math.floor(Math.random() * result.images.length) : 0);
      if (!result.images?.length && !cancelled) setLayers([emptyLayer, emptyLayer]);
    }).catch(() => { if (!cancelled) setImages([]); });
    return () => { cancelled = true; };
  }, [enabled, directory]);

  const current = images[index];
  React.useEffect(() => {
    let cancelled = false;
    let retryTimer = 0;
    if (!enabled || !current) return undefined;
    const fail = () => {
      if (cancelled) return;
      failedImagesRef.current.add(current.path);
      const nextIndex = images.findIndex((candidate, imageIndex) => imageIndex !== index && !failedImagesRef.current.has(candidate.path));
      if (nextIndex >= 0) retryTimer = window.setTimeout(() => { if (!cancelled) setIndex(nextIndex); }, 80);
    };
    const commit = (dataUrl: string) => {
      if (cancelled) return;
      const nextLayer: 0 | 1 = activeLayerRef.current === 0 ? 1 : 0;
      setLayers((old) => {
        return old.map((layer, layerIndex) => layerIndex === nextLayer
          ? { dataUrl, path: current.relativePath, visible: true }
          : { ...layer, visible: false }) as [ImageLayer, ImageLayer];
      });
      activeLayerRef.current = nextLayer;
    };
    const load = () => api.backgroundImages.read(current.path, directory).then((loaded) => {
      if (!cancelled) commit(loaded.dataUrl);
    });
    void load().catch(() => {
      retryTimer = window.setTimeout(() => {
        if (cancelled) return;
        void load().catch(fail);
      }, 200);
    });
    return () => { cancelled = true; window.clearTimeout(retryTimer); };
  }, [enabled, current?.path, directory, images, index]);

  React.useEffect(() => {
    if (!enabled || images.length < 2) return undefined;
    const seconds = settings.background_images_interval;
    const timer = window.setInterval(() => setIndex((currentIndex) => {
      const available = images.map((image, imageIndex) => ({ image, imageIndex })).filter(({ image }) => !failedImagesRef.current.has(image.path));
      if (available.length < 2) return currentIndex;
      if (order !== '随机') return available.find(({ imageIndex }) => imageIndex > currentIndex)?.imageIndex ?? available[0].imageIndex;
      const candidates = available.filter(({ imageIndex }) => imageIndex !== currentIndex);
      return candidates[Math.floor(Math.random() * candidates.length)].imageIndex;
    }), seconds * 1000);
    return () => window.clearInterval(timer);
  }, [enabled, images, order, settings.background_images_interval]);

  const blur = settings.background_images_blur;
  const imageOpacity = settings.background_images_opacity;
  const foregroundOpacity = enabled ? settings.background_images_foreground_opacity : 1;
  const imageStyle = {
    '--background-image-opacity': String(imageOpacity),
    '--background-image-blur': `${blur}px`,
    '--background-image-overscan': `${blur * 2}px`,
    '--background-image-position': alignmentMap[settings.background_images_alignment] || 'center center',
    '--background-image-repeat': repeatMap[settings.background_images_repeat] || 'no-repeat',
    '--background-image-size': sizeMap[settings.background_images_size] || 'cover',
  } as React.CSSProperties;

  return <div className={`app-frame ${enabled ? 'background-images-enabled' : ''}`}>
    <div className="app-background-layer" aria-hidden="true">{layers.map((layer, layerIndex) => <div className={`app-background-image ${layer.visible ? 'active' : ''}`} data-image-path={layer.path} style={{ ...imageStyle, backgroundImage: layer.dataUrl ? `url("${layer.dataUrl}")` : 'none', '--background-image-url': layer.dataUrl ? `url("${layer.dataUrl}")` : 'none' } as React.CSSProperties} key={layerIndex} />)}</div>
    <div className="app-foreground" style={{ opacity: foregroundOpacity }}>{children}</div>
  </div>;
}

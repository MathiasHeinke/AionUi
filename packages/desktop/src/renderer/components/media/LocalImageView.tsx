import { ipcBridge } from '@/common';
import { joinPath } from '@/common/chat/chatLib';
import { LoadingTwo } from '@renderer/components/icons';
import React, { useEffect, useMemo, useState } from 'react';
import { createContext } from '@renderer/utils/ui/createContext';

const [useLocalImage, LocalImageProvider, useUpdateLocalImage] = createContext({ root: '' });

const LocalImageView: React.FC<{
  src: string;
  alt: string;
  className?: string;
}> & {
  Provider: typeof LocalImageProvider;
  useUpdateLocalImage: typeof useUpdateLocalImage;
} = ({ src, alt, className }) => {
  const [loading, setLoading] = useState(true);
  const [url, setUrl] = useState(src);
  const [failed, setFailed] = useState(false);
  const { root } = useLocalImage();

  const absolutePath = useMemo(() => {
    if (!root) return src;
    if (
      src.startsWith('http') ||
      src.startsWith('data:') ||
      src.startsWith('/') ||
      src.startsWith('file:') ||
      src.startsWith('\\') ||
      /^[A-Za-z]:/.test(src)
    ) {
      return src;
    }
    return joinPath(root, src);
  }, [src, root]);

  useEffect(() => {
    setLoading(true);
    setFailed(false);
    ipcBridge.fs.getImageBase64
      .invoke({ path: absolutePath, workspace: root || undefined })
      .then((base64) => {
        if (base64) {
          setUrl(base64);
        } else {
          setFailed(true);
        }
        setLoading(false);
      })
      .catch((error) => {
        console.error('[LocalImageView] Failed to load image:', {
          path: absolutePath,
          error,
        });
        setFailed(true);
        setLoading(false);
      });
  }, [absolutePath, root]);
  if (loading)
    return (
      <span style={{ display: 'flex', alignItems: 'center', gap: '4px' }}>
        <LoadingTwo className='loading' style={{ display: 'flex' }} size='14' />
        <span>{alt}</span>
      </span>
    );
  if (failed) {
    return alt ? (
      <span role='img' aria-label={alt} className={className} data-testid='local-image-fallback'>
        {alt}
      </span>
    ) : null;
  }
  return <img src={url} alt={alt} className={className} onError={() => setFailed(true)} />;
};

LocalImageView.Provider = LocalImageProvider;
LocalImageView.useUpdateLocalImage = useUpdateLocalImage;

export default LocalImageView;

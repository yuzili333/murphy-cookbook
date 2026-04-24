import { useState } from 'react';

function buildPlaceholderDataUrl(label: string) {
  const safeLabel = label.replace(/[&<>"']/g, '').slice(0, 18) || '图片';
  const svg = `
    <svg xmlns="http://www.w3.org/2000/svg" width="640" height="420" viewBox="0 0 640 420" role="img" aria-label="${safeLabel}">
      <defs>
        <linearGradient id="bg" x1="0%" y1="0%" x2="100%" y2="100%">
          <stop offset="0%" stop-color="#ffe1c7" />
          <stop offset="100%" stop-color="#cfeedd" />
        </linearGradient>
      </defs>
      <rect width="640" height="420" rx="32" fill="url(#bg)" />
      <circle cx="320" cy="154" r="58" fill="rgba(255,255,255,0.5)" />
      <rect x="160" y="248" width="320" height="64" rx="20" fill="rgba(255,255,255,0.8)" />
      <text x="320" y="170" text-anchor="middle" font-size="52" fill="#2f8f83">IMG</text>
      <text x="320" y="288" text-anchor="middle" font-size="28" font-family="Arial, PingFang SC, sans-serif" fill="#274047">${safeLabel}</text>
    </svg>
  `;

  return `data:image/svg+xml;charset=UTF-8,${encodeURIComponent(svg)}`;
}

interface ZoomableImageProps {
  alt: string;
  src?: string;
  className: string;
}

export function ZoomableImage({ alt, src, className }: ZoomableImageProps) {
  const [isOpen, setIsOpen] = useState(false);
  const [hasError, setHasError] = useState(false);
  const resolvedSrc = !src || hasError ? buildPlaceholderDataUrl(alt) : src;

  return (
    <>
      <button
        type="button"
        className="zoomable-image-button"
        onClick={() => setIsOpen(true)}
        aria-label={`查看${alt}大图`}
      >
        <img
          className={className}
          src={resolvedSrc}
          alt={alt}
          loading="lazy"
          onError={() => setHasError(true)}
        />
      </button>

      {isOpen ? (
        <div className="image-lightbox" role="dialog" aria-modal="true" aria-label={`${alt}大图`}>
          <button
            type="button"
            className="image-lightbox-backdrop"
            aria-label="关闭大图"
            onClick={() => setIsOpen(false)}
          />
          <div className="image-lightbox-content">
            <img className="image-lightbox-image" src={resolvedSrc} alt={alt} />
            <div className="image-lightbox-toolbar">
              <strong>{alt}</strong>
              <button type="button" className="secondary-button" onClick={() => setIsOpen(false)}>
                关闭
              </button>
            </div>
          </div>
        </div>
      ) : null}
    </>
  );
}

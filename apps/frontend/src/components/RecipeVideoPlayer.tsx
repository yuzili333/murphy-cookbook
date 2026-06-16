import { useEffect, useMemo, useRef, useState } from 'react';
import videojs from 'video.js';
import 'video.js/dist/video-js.css';
import type { RecipeCookingVideo } from '../types';

interface RecipeVideoPlayerProps {
  video: RecipeCookingVideo;
  title: string;
  locale: 'zh' | 'en';
}

function inferVideoMimeType(url: string) {
  const pathname = new URL(url, window.location.href).pathname.toLocaleLowerCase();

  if (pathname.endsWith('.m3u8')) return 'application/x-mpegURL';
  if (pathname.endsWith('.webm')) return 'video/webm';
  if (pathname.endsWith('.ogg') || pathname.endsWith('.ogv')) return 'video/ogg';
  if (pathname.endsWith('.mov')) return 'video/quicktime';

  return 'video/mp4';
}

export function RecipeVideoPlayer({ video, title, locale }: RecipeVideoPlayerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const playerRef = useRef<ReturnType<typeof videojs> | null>(null);
  const [posterUrl, setPosterUrl] = useState('');

  useEffect(() => {
    if (!video.coverUrl) {
      setPosterUrl('');
      return;
    }

    let isActive = true;
    const image = new Image();
    image.onload = () => {
      if (isActive) {
        setPosterUrl(video.coverUrl);
      }
    };
    image.onerror = () => {
      if (isActive) {
        setPosterUrl('');
      }
    };
    image.src = video.coverUrl;

    return () => {
      isActive = false;
    };
  }, [video.coverUrl]);

  const options = useMemo(
    () => ({
      autoplay: false,
      controls: true,
      responsive: true,
      fluid: true,
      aspectRatio: '16:9',
      preload: 'metadata',
      poster: posterUrl,
      playsinline: true,
      enableSmoothSeeking: true,
      disablePictureInPicture: false,
      enableDocumentPictureInPicture: true,
      playbackRates: [0.5, 0.75, 1, 1.25, 1.5, 2],
      controlBar: {
        skipButtons: {
          backward: 10,
          forward: 10,
        },
        remainingTimeDisplay: {
          displayNegative: false,
        },
        children: [
          'playToggle',
          'skipBackward',
          'skipForward',
          'volumePanel',
          'currentTimeDisplay',
          'timeDivider',
          'durationDisplay',
          'progressControl',
          'remainingTimeDisplay',
          'playbackRateMenuButton',
          'pictureInPictureToggle',
          'fullscreenToggle',
        ],
      },
      sources: [
        {
          src: video.videoUrl,
          type: inferVideoMimeType(video.videoUrl),
        },
      ],
      notSupportedMessage:
        locale === 'en'
          ? 'This cooking video cannot be played in the current browser.'
          : '当前浏览器无法播放该烹饪视频。',
    }),
    [locale, posterUrl, video.videoUrl],
  );

  useEffect(() => {
    if (!containerRef.current) {
      return;
    }

    if (!playerRef.current) {
      const videoElement = document.createElement('video-js');
      videoElement.classList.add('video-js', 'vjs-big-play-centered', 'vjs-murphy-cooking-player');
      videoElement.setAttribute('aria-label', title);
      containerRef.current.appendChild(videoElement);
      playerRef.current = videojs(videoElement, options);
      return;
    }

    const player = playerRef.current;
    player.poster(posterUrl);
    player.src(options.sources);
    player.options(options);
  }, [options, posterUrl, title]);

  useEffect(() => {
    const player = playerRef.current;

    return () => {
      if (player && !player.isDisposed()) {
        player.dispose();
        playerRef.current = null;
      }
    };
  }, []);

  return (
    <div className="recipe-video-player-shell" data-vjs-player>
      <div ref={containerRef} />
    </div>
  );
}

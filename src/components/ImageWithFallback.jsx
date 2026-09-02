import { useState, useRef, useEffect } from 'react';
import { Image as ImageIcon } from 'lucide-react';

export default function ImageWithFallback({ src, alt, className, containerClassName }) {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState(false);
  const imgRef = useRef(null);

  // Check if image is already loaded (from cache)
  useEffect(() => {
    if (imgRef.current && imgRef.current.complete) {
      if (imgRef.current.naturalWidth === 0) {
        setError(true);
      } else {
        setLoaded(true);
      }
    }
  }, [src]);

  if (!src || error) {
    return (
      <div className={`flex items-center justify-center ${containerClassName || 'w-full h-full'}`}>
        <ImageIcon className="h-12 w-12 text-slate-300" />
      </div>
    );
  }

  return (
    <div className={`relative ${containerClassName || 'w-full h-full'}`}>
      {/* Skeleton / Placeholder while loading */}
      {!loaded && (
        <div className="absolute inset-0 bg-slate-200 animate-pulse rounded-md"></div>
      )}
      
      <img
        ref={imgRef}
        src={src}
        alt={alt}
        className={`${className} transition-opacity duration-500 ${loaded ? 'opacity-100' : 'opacity-0'}`}
        onLoad={() => setLoaded(true)}
        onError={() => setError(true)}
      />
    </div>
  );
}

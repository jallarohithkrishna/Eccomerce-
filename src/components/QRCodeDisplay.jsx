import { useState, useEffect } from 'react';
import QRCode from 'qrcode';

export default function QRCodeDisplay({
  value,
  size = 128,
  className = '',
  lightColor = '#FFFFFF',
  darkColor = '#0F172A',
  onClick = null
}) {
  const [qrDataUrl, setQrDataUrl] = useState('');
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!value) return;
    let isMounted = true;

    QRCode.toDataURL(value, {
      width: size * 2, // 2x for sharp retina displays
      margin: 1,
      color: {
        dark: darkColor,
        light: lightColor
      },
      errorCorrectionLevel: 'M'
    })
      .then((url) => {
        if (isMounted) setQrDataUrl(url);
      })
      .catch((err) => {
        console.error('Failed to generate QR code:', err);
        if (isMounted) setError(true);
      });

    return () => {
      isMounted = false;
    };
  }, [value, size, lightColor, darkColor]);

  if (error || !qrDataUrl) {
    return (
      <div
        style={{ width: size, height: size }}
        className={`bg-white/10 rounded-xl flex items-center justify-center animate-pulse ${className}`}
      >
        <span className="text-[10px] text-slate-400">Loading QR...</span>
      </div>
    );
  }

  return (
    <img
      src={qrDataUrl}
      alt="Scannable QR Code"
      style={{ width: size, height: size }}
      className={`rounded-xl object-contain shadow-sm transition-transform hover:scale-105 ${onClick ? 'cursor-pointer' : ''} ${className}`}
      onClick={onClick}
    />
  );
}

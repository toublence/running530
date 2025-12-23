import './globals.css'
import CameraCleanup from './components/CameraCleanup'
import PwaInit from './PwaInit'
import SafeAreaBottomInset from './components/SafeAreaBottomInset'
import RouteDepthTracker from './components/RouteDepthTracker'
import BackButtonGuard from './components/BackButtonGuard'
import IOSBackButton from './components/IOSBackButton'
import PortraitOrientationManager from './components/PortraitOrientationManager'

export const metadata = {
  title: 'Motion Fit - Pose Analysis',
  description: 'Modern pose analysis with MediaPipe',
  themeColor: '#0ea5e9',
  manifest: '/manifest.webmanifest',
}

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <head>
        <link rel="manifest" href="/manifest.webmanifest" />
        <meta name="theme-color" content="#0ea5e9" />
        <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
        <link rel="apple-touch-icon" href="/icons/icon-192.png" />
      </head>
      <body className="min-h-screen bg-gradient-to-br from-slate-50 to-blue-50 font-sans antialiased">
        <PwaInit />
        <RouteDepthTracker />
        <BackButtonGuard />
        <PortraitOrientationManager />
        <CameraCleanup />
        <IOSBackButton />
        <div className="min-h-screen flex flex-col">
          {children}
          <SafeAreaBottomInset />
        </div>
      </body>
    </html>
  )
}

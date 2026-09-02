import { useState } from 'react';
import { Link, useNavigate, Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ShoppingBag, ArrowRight, RefreshCw, CheckCircle, KeyRound, ArrowLeft, Mail } from 'lucide-react';

export default function Login() {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [isUnverified, setIsUnverified] = useState(false);
  
  // Forgot Password State
  const [isForgotPassword, setIsForgotPassword] = useState(false);
  const [resetEmail, setResetEmail] = useState('');
  const [resetLoading, setResetLoading] = useState(false);
  const [resetSuccess, setResetSuccess] = useState(false);
  const [resetError, setResetError] = useState('');
  
  const { signIn, signInWithGoogle, user, resendVerificationEmail, resetPassword } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const from = location.state?.from?.pathname || '/';

  // If already logged in, send them back where they came from (or home)
  if (user) {
    return <Navigate to={from} replace />;
  }

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setError('');
      setIsUnverified(false);
      setResendSuccess(false);
      setLoading(true);
      await signIn(email, password);
      navigate(from, { replace: true });
    } catch (err) {
      if (err.code === 'auth/email-not-verified') {
        setError('Please verify your email before signing in.');
        setIsUnverified(true);
      } else {
        setError(err.message || 'Failed to sign in');
      }
    } finally {
      setLoading(false);
    }
  };

  const handleResendEmail = async () => {
    try {
      setError('');
      setResendLoading(true);
      setResendSuccess(false);
      await resendVerificationEmail(email, password);
      setResendSuccess(true);
      setTimeout(() => setResendSuccess(false), 5000);
    } catch (err) {
      setError(err.message || 'Failed to resend verification email');
    } finally {
      setResendLoading(false);
    }
  };

  const handleForgotPasswordSubmit = async (e) => {
    e.preventDefault();
    if (!resetEmail) {
      setResetError('Please enter your email address');
      return;
    }
    try {
      setResetError('');
      setResetLoading(true);
      setResetSuccess(false);
      await resetPassword(resetEmail);
      setResetSuccess(true);
    } catch (err) {
      if (err.code === 'auth/user-not-found') {
        setResetError('No account found with this email address.');
      } else if (err.code === 'auth/invalid-email') {
        setResetError('Please enter a valid email address.');
      } else {
        setResetError(err.message || 'Failed to send password reset email.');
      }
    } finally {
      setResetLoading(false);
    }
  };

  const handleGoogleLogin = async () => {
    try {
      setError('');
      setGoogleLoading(true);
      await signInWithGoogle();
      // OAuth redirects, so we don't navigate manually
    } catch (err) {
      setError(err.message || 'Failed to sign in with Google');
      setGoogleLoading(false);
    }
  };

  // ── Forgot Password Screen ──
  if (isForgotPassword) {
    return (
      <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="px-8 pt-10 pb-8 border-b border-slate-100 flex flex-col items-center">
            <div className="h-14 w-14 bg-amber-50 rounded-2xl flex items-center justify-center mb-6 text-amber-600">
              <KeyRound className="h-8 w-8" />
            </div>
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Reset Password</h2>
            <p className="mt-2 text-sm text-slate-500 text-center">
              Enter your email and we'll send you a link to reset your password.
            </p>
          </div>

          <div className="px-8 py-8 bg-white">
            {resetError && (
              <div className="mb-6 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
                {resetError}
              </div>
            )}

            {resetSuccess ? (
              <div className="space-y-6">
                <div className="bg-green-50 border border-green-200 text-green-700 px-4 py-4 rounded-xl text-sm flex flex-col items-center text-center">
                  <CheckCircle className="h-8 w-8 text-green-600 mb-2" />
                  <p className="font-semibold text-base mb-1">Reset Link Sent!</p>
                  <p className="text-slate-600">
                    We sent a password reset link to <strong>{resetEmail}</strong>. Please check your inbox (and spam folder).
                  </p>
                </div>
                <button
                  onClick={() => {
                    setIsForgotPassword(false);
                    setResetSuccess(false);
                  }}
                  className="w-full btn btn-primary flex justify-center items-center py-3"
                >
                  Return to Sign In
                </button>
              </div>
            ) : (
              <form onSubmit={handleForgotPasswordSubmit} className="space-y-6">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-2">Email Address</label>
                  <div className="relative">
                    <input
                      type="email"
                      required
                      className="input"
                      value={resetEmail}
                      onChange={(e) => setResetEmail(e.target.value)}
                      placeholder="you@example.com"
                    />
                  </div>
                </div>

                <button
                  type="submit"
                  disabled={resetLoading}
                  className="w-full btn btn-primary flex justify-center items-center py-3 group"
                >
                  {resetLoading ? 'Sending link...' : 'Send Reset Link'}
                  {!resetLoading && <Mail className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />}
                </button>

                <div className="pt-2 text-center">
                  <button
                    type="button"
                    onClick={() => {
                      setIsForgotPassword(false);
                      setResetError('');
                    }}
                    className="inline-flex items-center text-sm font-medium text-slate-600 hover:text-slate-900 transition-colors"
                  >
                    <ArrowLeft className="h-4 w-4 mr-1" />
                    Back to Sign In
                  </button>
                </div>
              </form>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="px-8 pt-10 pb-8 border-b border-slate-100 flex flex-col items-center">
          <div className="h-14 w-14 bg-primary-50 rounded-2xl flex items-center justify-center mb-6 text-primary-600">
            <ShoppingBag className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Welcome back</h2>
          <p className="mt-2 text-sm text-slate-500">
            Please enter your details to sign in
          </p>
        </div>

        <div className="px-8 py-8 bg-white">
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
          )}

          {resendSuccess && (
            <div className="mb-6 bg-green-50 border border-green-200 text-green-600 px-4 py-3 rounded-lg text-sm flex items-center">
              <CheckCircle className="h-4 w-4 mr-2 flex-shrink-0" />
              Verification email sent! Check your inbox.
            </div>
          )}

          {isUnverified && !resendSuccess && (
            <button
              onClick={handleResendEmail}
              disabled={resendLoading}
              className="w-full flex justify-center items-center py-3 px-4 border border-blue-300 rounded-lg shadow-sm bg-blue-50 text-sm font-medium text-blue-700 hover:bg-blue-100 transition-colors mb-6"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${resendLoading ? 'animate-spin' : ''}`} />
              {resendLoading ? 'Sending...' : 'Resend verification email'}
            </button>
          )}

          <button
            onClick={handleGoogleLogin}
            disabled={googleLoading || loading}
            className="w-full flex justify-center items-center py-3 px-4 border border-slate-300 rounded-lg shadow-sm bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors mb-6"
          >
            <svg className="h-5 w-5 mr-2" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
              <path d="M22.56 12.25c0-.78-.07-1.53-.2-2.25H12v4.26h5.92c-.26 1.37-1.04 2.53-2.21 3.31v2.77h3.57c2.08-1.92 3.28-4.74 3.28-8.09z" fill="#4285F4" />
              <path d="M12 23c2.97 0 5.46-.98 7.28-2.66l-3.57-2.77c-.98.66-2.23 1.06-3.71 1.06-2.86 0-5.29-1.93-6.16-4.53H2.18v2.84C3.99 20.53 7.7 23 12 23z" fill="#34A853" />
              <path d="M5.84 14.09c-.22-.66-.35-1.36-.35-2.09s.13-1.43.35-2.09V7.07H2.18C1.43 8.55 1 10.22 1 12s.43 3.45 1.18 4.93l2.85-2.22.81-.62z" fill="#FBBC05" />
              <path d="M12 5.38c1.62 0 3.06.56 4.21 1.64l3.15-3.15C17.45 2.09 14.97 1 12 1 7.7 1 3.99 3.47 2.18 7.07l3.66 2.84c.87-2.6 3.3-4.53 6.16-4.53z" fill="#EA4335" />
            </svg>
            {googleLoading ? 'Connecting...' : 'Continue with Google'}
          </button>

          <div className="relative mb-6">
            <div className="absolute inset-0 flex items-center">
              <div className="w-full border-t border-slate-200"></div>
            </div>
            <div className="relative flex justify-center text-sm">
              <span className="px-2 bg-white text-slate-500">Or continue with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Email Address</label>
              <input
                type="email"
                required
                className="input"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </div>

            <div>
              <div className="flex justify-between items-center mb-2">
                <label className="block text-sm font-medium text-slate-700">Password</label>
                <button
                  type="button"
                  onClick={() => {
                    setResetEmail(email);
                    setResetError('');
                    setResetSuccess(false);
                    setIsForgotPassword(true);
                  }}
                  className="text-xs font-medium text-primary-600 hover:text-primary-500 transition-colors"
                >
                  Forgot password?
                </button>
              </div>
              <input
                type="password"
                required
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full btn btn-primary flex justify-center items-center py-3 group"
            >
              {loading ? 'Signing in...' : 'Sign in'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />}
            </button>
          </form>
          
          <div className="mt-8 text-center text-sm text-slate-600">
            Don't have an account?{' '}
            <Link to="/register" className="font-semibold text-primary-600 hover:text-primary-500 transition-colors">
              Sign up
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

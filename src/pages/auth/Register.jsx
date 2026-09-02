import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { ShoppingBag, ArrowRight, Mail, RefreshCw, CheckCircle } from 'lucide-react';

export default function Register() {
  const [fullName, setFullName] = useState('');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [googleLoading, setGoogleLoading] = useState(false);
  const [pendingVerification, setPendingVerification] = useState(false);
  const [resendLoading, setResendLoading] = useState(false);
  const [resendSuccess, setResendSuccess] = useState(false);
  const [verifyLoading, setVerifyLoading] = useState(false);
  
  const { signUp, signIn, signInWithGoogle, resendVerificationEmail } = useAuth();
  const navigate = useNavigate();

  const handleSubmit = async (e) => {
    e.preventDefault();
    try {
      setError('');
      setLoading(true);
      const result = await signUp(email, password, fullName);
      if (result?.pendingVerification) {
        setPendingVerification(true);
      }
    } catch (err) {
      setError(err.message || 'Failed to create account');
    } finally {
      setLoading(false);
    }
  };

  const handleVerifyAndSignIn = async () => {
    try {
      setError('');
      setVerifyLoading(true);
      await signIn(email, password);
      navigate('/', { replace: true });
    } catch (err) {
      if (err.code === 'auth/email-not-verified') {
        setError('Email not verified yet. Please check your inbox and click the verification link, then try again.');
      } else {
        setError(err.message || 'Failed to sign in');
      }
    } finally {
      setVerifyLoading(false);
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

  // ── Verification Pending Screen ──
  if (pendingVerification) {
    return (
      <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-50">
        <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
          <div className="px-8 pt-10 pb-8 border-b border-slate-100 flex flex-col items-center">
            <div className="h-14 w-14 bg-blue-50 rounded-2xl flex items-center justify-center mb-6 text-blue-600">
              <Mail className="h-8 w-8" />
            </div>
            <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Check your inbox</h2>
            <p className="mt-2 text-sm text-slate-500 text-center">
              We've sent a verification link to
            </p>
            <p className="mt-1 text-sm font-semibold text-slate-800">{email}</p>
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
                Verification email resent successfully!
              </div>
            )}

            <div className="bg-slate-50 rounded-lg p-4 mb-6">
              <p className="text-sm text-slate-600 leading-relaxed">
                Click the verification link in your email, then come back and press the button below to sign in.
              </p>
            </div>

            <button
              onClick={handleVerifyAndSignIn}
              disabled={verifyLoading}
              className="w-full btn btn-primary flex justify-center items-center py-3 group mb-4"
            >
              {verifyLoading ? 'Checking...' : "I've verified — Sign In"}
              {!verifyLoading && <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />}
            </button>

            <button
              onClick={handleResendEmail}
              disabled={resendLoading}
              className="w-full flex justify-center items-center py-3 px-4 border border-slate-300 rounded-lg shadow-sm bg-white text-sm font-medium text-slate-700 hover:bg-slate-50 transition-colors"
            >
              <RefreshCw className={`h-4 w-4 mr-2 ${resendLoading ? 'animate-spin' : ''}`} />
              {resendLoading ? 'Sending...' : 'Resend verification email'}
            </button>

            <div className="mt-8 text-center text-sm text-slate-600">
              Wrong email?{' '}
              <button 
                onClick={() => { setPendingVerification(false); setError(''); }}
                className="font-semibold text-primary-600 hover:text-primary-500 transition-colors"
              >
                Go back
              </button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  // ── Registration Form ──
  return (
    <div className="min-h-screen flex items-center justify-center py-12 px-4 sm:px-6 lg:px-8 bg-slate-50">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl overflow-hidden">
        <div className="px-8 pt-10 pb-8 border-b border-slate-100 flex flex-col items-center">
          <div className="h-14 w-14 bg-primary-50 rounded-2xl flex items-center justify-center mb-6 text-primary-600">
            <ShoppingBag className="h-8 w-8" />
          </div>
          <h2 className="text-2xl font-bold text-slate-900 tracking-tight">Create an account</h2>
          <p className="mt-2 text-sm text-slate-500">
            Join SmartCart today
          </p>
        </div>

        <div className="px-8 py-8 bg-white">
          {error && (
            <div className="mb-6 bg-red-50 border border-red-200 text-red-600 px-4 py-3 rounded-lg text-sm">
              {error}
            </div>
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
              <span className="px-2 bg-white text-slate-500">Or sign up with email</span>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            <div>
              <label className="block text-sm font-medium text-slate-700 mb-2">Full Name</label>
              <input
                type="text"
                required
                className="input"
                value={fullName}
                onChange={(e) => setFullName(e.target.value)}
                placeholder="John Doe"
              />
            </div>

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
              <label className="block text-sm font-medium text-slate-700 mb-2">Password</label>
              <input
                type="password"
                required
                className="input"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder="••••••••"
                minLength="6"
              />
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full btn btn-primary flex justify-center items-center py-3 group"
            >
              {loading ? 'Creating account...' : 'Create account'}
              {!loading && <ArrowRight className="ml-2 h-4 w-4 group-hover:translate-x-1 transition-transform" />}
            </button>
          </form>
          
          <div className="mt-8 text-center text-sm text-slate-600">
            Already have an account?{' '}
            <Link to="/login" className="font-semibold text-primary-600 hover:text-primary-500 transition-colors">
              Sign in
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}

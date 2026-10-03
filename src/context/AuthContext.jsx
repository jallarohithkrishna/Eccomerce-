import { createContext, useContext, useState, useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { FirebaseAuthentication } from '@capacitor-firebase/authentication';
import { auth, db } from '../lib/firebase';
import { 
  createUserWithEmailAndPassword, 
  signInWithEmailAndPassword, 
  signOut as firebaseSignOut, 
  onAuthStateChanged,
  GoogleAuthProvider,
  signInWithPopup,
  signInWithCredential,
  updateProfile,
  sendEmailVerification,
  sendPasswordResetEmail
} from 'firebase/auth';
import { doc, setDoc, getDoc } from 'firebase/firestore';

const AuthContext = createContext();

export function AuthProvider({ children }) {
  const [user, setUser] = useState(null);
  const [role, setRole] = useState('customer');
  const [claims, setClaims] = useState({});
  const [loading, setLoading] = useState(true);

  const refreshUserClaims = async (firebaseUser) => {
    if (!firebaseUser) {
      setRole('customer');
      setClaims({});
      return;
    }
    try {
      const idTokenResult = await firebaseUser.getIdTokenResult(true);
      const userRole = idTokenResult.claims.role || 'customer';
      setClaims(idTokenResult.claims);
      setRole(userRole);
      return userRole;
    } catch (err) {
      console.error('Failed to get token claims:', err);
      setRole('customer');
      return 'customer';
    }
  };

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Only allow verified users (or Google users who are always verified)
        if (!currentUser.emailVerified) {
          setUser(null);
          setRole('customer');
          setClaims({});
          setLoading(false);
          return;
        }

        // Fetch custom claims from token
        let userRole = 'customer';
        try {
          const idTokenResult = await currentUser.getIdTokenResult();
          userRole = idTokenResult.claims.role || 'customer';
          setClaims(idTokenResult.claims);
          setRole(userRole);
        } catch (claimsErr) {
          console.error('Error fetching auth claims:', claimsErr);
        }

        // Fetch custom user data from Firestore if needed
        let userData = { full_name: currentUser.displayName, role: userRole };
        try {
          const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
          if (userDoc.exists()) {
            userData = { ...userDoc.data(), role: userRole };
          }
        } catch {
          // If rules restrict read, fallback to auth token info
        }

        setUser({
          ...currentUser,
          role: userRole,
          user_metadata: userData
        });
      } else {
        setUser(null);
        setRole('customer');
        setClaims({});
      }
      setLoading(false);
    });

    return () => unsubscribe();
  }, []);

  const signUp = async (email, password, fullName) => {
    const userCredential = await createUserWithEmailAndPassword(auth, email, password);
    const newUser = userCredential.user;
    
    // Update auth profile with display name
    await updateProfile(newUser, { displayName: fullName });
    
    // Send verification email
    await sendEmailVerification(newUser);
    
    // Sign out immediately — user must verify before accessing the app
    await firebaseSignOut(auth);
    
    return { pendingVerification: true, email };
  };

  const signIn = async (email, password) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const loggedInUser = userCredential.user;
    
    // Force reload to get latest emailVerified status
    await loggedInUser.reload();
    
    if (!loggedInUser.emailVerified) {
      await firebaseSignOut(auth);
      const error = new Error('Please verify your email before signing in. Check your inbox for the verification link.');
      error.code = 'auth/email-not-verified';
      throw error;
    }
    
    // Email is verified — ensure Firestore user doc exists
    const userDocRef = doc(db, 'users', loggedInUser.uid);
    try {
      const userDocSnap = await getDoc(userDocRef);
      if (!userDocSnap.exists()) {
        await setDoc(userDocRef, {
          email: loggedInUser.email,
          full_name: loggedInUser.displayName,
          created_at: new Date().toISOString(),
          role: 'customer'
        });
      }
    } catch {
      // Ignored if rules prevent creation before verification
    }
    
    await refreshUserClaims(loggedInUser);
    return loggedInUser;
  };

  const resendVerificationEmail = async (email, password) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const resendUser = userCredential.user;
    await sendEmailVerification(resendUser);
    await firebaseSignOut(auth);
  };

  const resetPassword = async (email) => {
    await sendPasswordResetEmail(auth, email);
  };

  const signInWithGoogle = async () => {
    let resultUser;
    
    if (Capacitor.isNativePlatform()) {
      const result = await FirebaseAuthentication.signInWithGoogle({
        useCredentialManager: false
      });
      const credential = GoogleAuthProvider.credential(result.credential?.idToken);
      const authResult = await signInWithCredential(auth, credential);
      resultUser = authResult.user;
    } else {
      const provider = new GoogleAuthProvider();
      provider.setCustomParameters({
        prompt: 'select_account'
      });
      const authResult = await signInWithPopup(auth, provider);
      resultUser = authResult.user;
    }
    
    const googleUser = resultUser;
    
    // Ensure user document exists in Firestore
    const userDocRef = doc(db, 'users', googleUser.uid);
    try {
      const userDocSnap = await getDoc(userDocRef);
      if (!userDocSnap.exists()) {
        await setDoc(userDocRef, {
          email: googleUser.email,
          full_name: googleUser.displayName,
          avatar_url: googleUser.photoURL,
          created_at: new Date().toISOString(),
          role: 'customer'
        });
      }
    } catch {
      // Handled
    }
    
    await refreshUserClaims(googleUser);
    return googleUser;
  };

  const signOut = async () => {
    if (Capacitor.isNativePlatform()) {
      try {
        await FirebaseAuthentication.signOut();
      } catch (error) {
        console.error('Error signing out from native Firebase Auth:', error);
      }
    }
    await firebaseSignOut(auth);
    setUser(null);
    setRole('customer');
    setClaims({});
  };

  const getIdToken = async (forceRefresh = false) => {
    if (!auth.currentUser) return null;
    return await auth.currentUser.getIdToken(forceRefresh);
  };

  const isAdmin = role === 'admin';
  const isStaff = ['admin', 'staff'].includes(role);
  const isWarehouse = ['admin', 'warehouse'].includes(role);

  return (
    <AuthContext.Provider value={{ 
      user, 
      role, 
      claims, 
      isAdmin, 
      isStaff, 
      isWarehouse, 
      loading, 
      signUp, 
      signIn, 
      signInWithGoogle, 
      signOut, 
      resendVerificationEmail, 
      resetPassword,
      getIdToken,
      refreshUserClaims
    }}>
      {!loading && children}
    </AuthContext.Provider>
  );
}

// eslint-disable-next-line react-refresh/only-export-components
export function useAuth() {
  const context = useContext(AuthContext);
  if (context === undefined) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}

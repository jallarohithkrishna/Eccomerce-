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
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const unsubscribe = onAuthStateChanged(auth, async (currentUser) => {
      if (currentUser) {
        // Only allow verified users (or Google users who are always verified)
        if (!currentUser.emailVerified) {
          setUser(null);
          setLoading(false);
          return;
        }
        // Fetch custom user data from Firestore if needed
        const userDoc = await getDoc(doc(db, 'users', currentUser.uid));
        setUser({
          ...currentUser,
          user_metadata: userDoc.exists() ? userDoc.data() : { full_name: currentUser.displayName }
        });
      } else {
        setUser(null);
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
    // Do NOT create Firestore doc yet
    await firebaseSignOut(auth);
    
    return { pendingVerification: true, email };
  };

  const signIn = async (email, password) => {
    const userCredential = await signInWithEmailAndPassword(auth, email, password);
    const loggedInUser = userCredential.user;
    
    // Force reload to get latest emailVerified status
    await loggedInUser.reload();
    
    if (!loggedInUser.emailVerified) {
      // Not verified — sign out and block
      await firebaseSignOut(auth);
      const error = new Error('Please verify your email before signing in. Check your inbox for the verification link.');
      error.code = 'auth/email-not-verified';
      throw error;
    }
    
    // Email is verified — ensure Firestore user doc exists
    const userDocRef = doc(db, 'users', loggedInUser.uid);
    const userDocSnap = await getDoc(userDocRef);
    
    if (!userDocSnap.exists()) {
      await setDoc(userDocRef, {
        email: loggedInUser.email,
        full_name: loggedInUser.displayName,
        created_at: new Date().toISOString(),
        role: 'customer'
      });
    }
    
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
  };

  return (
    <AuthContext.Provider value={{ user, loading, signUp, signIn, signInWithGoogle, signOut, resendVerificationEmail, resetPassword }}>
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

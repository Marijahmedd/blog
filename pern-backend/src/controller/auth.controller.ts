import { date, string } from "zod";
import { prisma } from "../lib/dbConnect";
import { comparePassword, hashPassword } from "../lib/hash";
import { sendVerificationEmail } from "../lib/sendEmail";
import { generateToken } from "../lib/token";
import { registrationSchema, passwordRecoverySchema } from "../lib/validation";
import { Request, Response } from "express";
import jwt from "jsonwebtoken";
import { parse } from "path";
import { sendPasswordEmail } from "../lib/sendPasswordEmail";
export const register = async (req: Request, res: Response) => {
  try {
    const parsed = registrationSchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(400).json({ error: "Invalid input" });
      return;
    }
    const { email, password } = parsed.data;

    const existingUser = await prisma.user.findUnique({ where: { email } });
    if (existingUser) {
      res.status(400).json({ error: "Email already registered" });
      return;
    }
    const HashedPassword = await hashPassword(password);
    let newUser = null;
    try {
      newUser = await prisma.user.create({
        data: {
          email,
          password: HashedPassword,
        },
      });
    } catch (createError) {
      res.status(400).json({ error: "Error Creating user" });
      return;
    }

    const token = generateToken();
    const expires = new Date(Date.now() + 1000 * 60 * 60); // 1 hour

    let storeToken = null;
    try {
      storeToken = await prisma.emailVerificationToken.create({
        data: {
          token,
          expiresAt: expires,
          userId: newUser.id,
        },
      });
    } catch (storeTokenError) {
      res.status(400).json({ error: "error storing token to db" });
      return;
    }
    let verificationMail = null;
    try {
      verificationMail = await sendVerificationEmail(email, token);
    } catch (verificationMailError) {
      console.log("verification mail error", verificationMailError);
      res.status(500).json({ error: "verification mail error" });
      return;
    }
    res.status(201).json({
      message: "user Created successfully ",
      newUser,
      storeToken,
      verificationMail,
    });
    return;
  } catch (error) {
    res.status(500).json({ error: "something went wrong" });
    return;
  }
};

export async function verify(req: Request, res: Response) {
  try {
    const { token } = req.body;

    if (!token) {
      res.status(404).json({ error: "Token Missing! " });
      return;
    }
    const VerificationRecord = await prisma.emailVerificationToken.findUnique({
      where: {
        token,
      },
      include: {
        user: true,
      },
    });
    if (
      !VerificationRecord ||
      VerificationRecord.expiresAt.getTime() < Date.now()
    ) {
      res.status(400).json({ error: "Token invalid or expired" });
      return;
    }

    const userVerified = await prisma.user.update({
      where: {
        id: VerificationRecord.user.id,
      },
      data: {
        verified: true,
      },
    });
    await prisma.emailVerificationToken.delete({
      where: { token },
    });
    res.status(200).json({ message: "User Verified ", userVerified });
    return;
  } catch (error) {
    res.status(500).json({ message: "Something Went Wrong ", error });
    return;
  }
}

import fs from "fs";
import path from "path";
import { error } from "console";
export async function login(req: Request, res: Response) {
  const privateKey = process.env.PRIVATE_KEY!;

  const refreshPrivateKey = process.env.REFRESH_PRIVATE_KEY!;
  try {
    const { email, password } = req.body;
    let user = null;
    try {
      user = await prisma.user.findUnique({
        where: {
          email,
        },
      });
    } catch (userError) {
      res.status(500).json({ error: "error fetching user data" });
      return;
    }

    if (!user) {
      res.status(404).json({ error: "User not found" });
      return;
    }

    const correctPassword = await comparePassword(password, user.password);
    if (!correctPassword) {
      res.status(401).json({ error: "Incorrect email or password" });
      return;
    }

    const refreshToken = jwt.sign(
      {
        sub: user.id,
        version: user.tokenVersion,
      },
      refreshPrivateKey,
      {
        algorithm: "RS256",
        expiresIn: "7d",
      }
    );
    const token = jwt.sign(
      {
        sub: user.id,
        isVerified: user.verified,
        email: user.email,
      },
      privateKey,
      {
        algorithm: "RS256",
        expiresIn: "1m",
      }
    );
    res.cookie("refreshToken", refreshToken, {
      path: "/",
      httpOnly: true,
      secure: false,
      sameSite: "lax",
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });
    res.status(200).json({ message: "Successfully login", accessToken: token });
    return;
  } catch (error) {
    res.status(500).json({ error: "Internal error" });
    return;
  }
}

export async function recoverPassword(req: Request, res: Response) {
  const parsed = passwordRecoverySchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(500).json({ error: "invalid email" });
    return;
  }
  const { email } = parsed.data;
  let user = null;
  try {
    user = await prisma.user.findUnique({
      where: { email },
      include: { verificationToken: true },
    });
    if (!user) {
      res.status(404).json({ error: "user not found" });
      return;
    }
  } catch (error) {
    res.status(500).json({ error: "Internal error" });
    return;
  }

  try {
    const token = generateToken();
    if (!user.verificationToken) {
      const createToken = await prisma.emailVerificationToken.create({
        data: {
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });
      await sendPasswordEmail(user.email, token);

      res.status(200).json({ message: "Reset password link sent to the mail" });
      return;
    }
    if (user.verificationToken) {
      const updateToken = await prisma.emailVerificationToken.update({
        where: { userId: user.id },
        data: {
          userId: user.id,
          token,
          expiresAt: new Date(Date.now() + 1000 * 60 * 60),
        },
      });
      await sendPasswordEmail(user.email, token);

      res.status(200).json({ message: "Reset password link sent to the mail" });
      return;
    }
  } catch (error) {
    res.status(500).json({ error: "error creating new token" });
    return;
  }
}

export async function setPassword(req: Request, res: Response) {
  const { token, password, passwordAgain } = req.body;

  try {
    const userData = await prisma.emailVerificationToken.findUnique({
      where: {
        token,
      },
      include: {
        user: true,
      },
    });
    if (!userData || userData.expiresAt.getTime() < Date.now()) {
      res.status(404).json({ error: "Invalid or expired token" });
      return;
    }
    if (password !== passwordAgain) {
      res.status(500).json({ message: "Passwords Do not Match" });
      return;
    }

    const hashedPassword = await hashPassword(password);

    const updatePassword = await prisma.user.update({
      where: {
        id: userData.userId,
      },
      data: {
        password: hashedPassword,
        verified: true,
        tokenVersion: { increment: 1 },
      },
    });

    await prisma.emailVerificationToken.delete({
      where: {
        token,
      },
    });

    res
      .status(200)
      .json({ message: "Password reset successful", updatePassword });
    return;
  } catch (error) {
    res.status(500).json({ message: "Something went wrong" });
    return;
  }
}

export async function validateToken(req: Request, res: Response) {
  const token = req.query.token as string;

  if (!token) {
    res.status(400).json({ error: "Token is required" });
    return;
  }

  try {
    const tokenRecord = await prisma.emailVerificationToken.findUnique({
      where: {
        token,
      },
    });

    if (!tokenRecord || tokenRecord.expiresAt < new Date()) {
      res.status(400).json({ error: "Token is invalid or expired" });
      return;
    }

    res.status(200).json({ message: "Token is valid" });
    return;
  } catch (error) {
    res.status(500).json({ error: "Server error" });
    return;
  }
}

export async function refreshAccessToken(req: Request, res: Response) {
  const RefreshPublicKey = process.env.REFRESH_PUBLIC_KEY!;

  const privateKey = process.env.PRIVATE_KEY!;

  const refreshToken = req.cookies.refreshToken;
  if (!refreshToken) {
    res.status(401).json({ error: "Refresh Token expired. Login Again" });
    return;
  }
  let decoded = null;
  try {
    decoded = jwt.verify(refreshToken, RefreshPublicKey, {
      algorithms: ["RS256"],
    }) as { sub: string; version: number };
  } catch (error) {
    res.status(403).json({ error: "Invalid refresh token" });
    return;
  }
  const user = await prisma.user.findUnique({ where: { id: decoded.sub } });

  if (!user) {
    res.status(404).json({ error: "User not found" });
    return;
  }
  if (user.tokenVersion !== decoded.version) {
    res.clearCookie("refreshToken", {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "lax",
    });
    res.status(401).json({ error: "outdated token version" });

    return;
  }
  console.log("generating new access token");
  const newAccessToken = jwt.sign(
    {
      sub: user.id,
      isVerified: user.verified,
      email: user.email,
    },
    privateKey,
    {
      algorithm: "RS256",
      expiresIn: "1m", // ✅ Shorter duration
    }
  );

  res.status(200).json({ accessToken: newAccessToken });
}

export async function logout(req: Request, res: Response) {
  const publicKey = process.env.PUBLIC_KEY!;
  const refreshSecret = process.env.REFRESH_PUBLIC_KEY!;

  const privateKey = process.env.PRIVATE_KEY!;

  const refreshPrivateKey = process.env.REFRESH_PRIVATE_KEY!;
  let userId: string | null = null;

  // 🔹 Try to extract user ID from access token (if still valid)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith("Bearer ")) {
    const token = authHeader.split(" ")[1];
    try {
      const decoded = jwt.verify(token, publicKey, {
        algorithms: ["RS256"],
      }) as { sub: string; version: number };
      userId = decoded.sub;
    } catch (error) {
      console.log(
        "⚠️ Access token expired or invalid. Falling back to refresh token."
      );
    }
  }

  // 🔹 If access token is expired, check refresh token instead
  if (!userId && req.cookies.refreshToken) {
    try {
      const decoded = jwt.verify(req.cookies.refreshToken, refreshSecret) as {
        sub: string;
      };
      userId = decoded.sub;
    } catch (error) {
      console.log("❌ Invalid refresh token. Cannot update token version.");
    }
  }

  // 🔹 If we have a valid user ID, increment tokenVersion
  if (userId) {
    console.log("updating token version");
    await prisma.user.update({
      where: { id: userId },
      data: { tokenVersion: { increment: 1 } }, // 🚀 Invalidate old refresh tokens
    });
  }

  // 🔹 Clear the refresh token properly
  res.cookie("refreshToken", "", {
    httpOnly: true,
    secure: true,
    sameSite: "strict",
    expires: new Date(0), // 🔥 Expire it instantly
    path: "/", // Match original path
  });
  console.log("logged out successfully");
  res.status(200).json({ message: "Logged out successfully" });
  return;
}

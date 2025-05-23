"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.passwordRecoverySchema = exports.registrationSchema = void 0;
const zod_1 = require("zod");
exports.registrationSchema = zod_1.z.object({
    email: zod_1.z.string().email(),
    password: zod_1.z.string().min(6),
});
exports.passwordRecoverySchema = zod_1.z.object({
    email: zod_1.z.string().email(),
});

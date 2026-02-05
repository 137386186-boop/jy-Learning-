import path from 'path';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import * as bcrypt from 'bcryptjs';

dotenv.config({ path: path.resolve(process.cwd(), '../.env') });
dotenv.config({ path: path.resolve(process.cwd(), '.env') });

const prisma = new PrismaClient();

async function main() {
  const username = process.env.ADMIN_USERNAME || 'admin';
  const password = process.env.ADMIN_PASSWORD;
  const forceReset = process.env.ADMIN_FORCE_RESET === 'true';

  if (!password) {
    console.error('ADMIN_PASSWORD is required to create admin');
    process.exit(1);
  }

  const existing = await prisma.admin.findUnique({ where: { username } });
  if (existing && !forceReset) {
    console.log(`Admin "${username}" already exists. Set ADMIN_FORCE_RESET=true to reset.`);
    return;
  }

  const passwordHash = await bcrypt.hash(password, 10);
  if (existing) {
    await prisma.admin.update({ where: { username }, data: { passwordHash } });
    console.log(`Admin "${username}" password reset.`);
  } else {
    await prisma.admin.create({ data: { username, passwordHash } });
    console.log(`Admin "${username}" created.`);
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });

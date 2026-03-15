const fs = require('fs');
const path = require('path');
const readline = require('readline');

try {
  require.resolve('archiver');
  require.resolve('archiver-zip-encrypted');
} catch (e) {
  console.error("❌ 错误: 缺少必要的压缩库。");
  console.error("请先在当前目录下运行以下命令安装:");
  console.error("npm install archiver archiver-zip-encrypted");
  process.exit(1);
}

const archiver = require('archiver');
archiver.registerFormat('zip-encrypted', require('archiver-zip-encrypted'));

// 使用简单的 readline 来获取密码（为保证兼容性，暂时不隐藏输入内容）
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout
});

const askPassword = (query) => {
  return new Promise((resolve) => {
    rl.question(query, (answer) => resolve(answer));
  });
};

async function main() {
  const authDir = path.join(__dirname, 'auth');
  const outputFilename = 'auth.zip';
  const innerZipName = 'data.bundle';

  if (!fs.existsSync(authDir)) {
    console.error(`错误: 未找到 auth 目录 (${authDir})`);
    rl.close();
    return;
  }

  const files = fs.readdirSync(authDir).filter(f => f.endsWith('.json'));
  if (files.length === 0) {
    console.error("错误: auth 目录下没有 .json 文件。");
    rl.close();
    return;
  }

  console.log(`找到 ${files.length} 个认证文件。`);
  
  const password = await askPassword("请输入 ZIP 加密密码: ");
  const confirmPassword = await askPassword("请再次确认密码: ");

  if (password !== confirmPassword) {
    console.error("❌ 错误: 两次输入的密码不一致！");
    rl.close();
    return;
  }

  if (!password) {
    console.error("❌ 错误: 密码不能为空。");
    rl.close();
    return;
  }

  // 关闭 readline 以防止程序挂起
  rl.close();

  console.log("正在进行第一层打包（隐藏文件名）...");

  try {
    // 1. 生成内部无密码 ZIP
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(innerZipName);
      const archive = archiver('zip', { zlib: { level: 9 } });
      
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      
      for (const file of files) {
        archive.file(path.join(authDir, file), { name: `auth/${file}` });
      }
      archive.finalize();
    });

    console.log("正在进行第二层加密压缩...");

    // 2. 生成外部加密 ZIP
    await new Promise((resolve, reject) => {
      const output = fs.createWriteStream(outputFilename);
      const archive = archiver('zip-encrypted', {
        zlib: { level: 9 },
        encryptionMethod: 'zip20', // 标准 zip 加密 (兼容 Linux 下老版 unzip)
        password: password
      });
      
      output.on('close', resolve);
      archive.on('error', reject);
      archive.pipe(output);
      
      archive.file(innerZipName, { name: 'bundle.zip' });
      archive.finalize();
    });

    // 3. 清理临时文件
    if (fs.existsSync(innerZipName)) {
      fs.unlinkSync(innerZipName);
    }

    console.log(`\n✅ 成功！双层加密后的文件已保存为: ${path.resolve(outputFilename)}`);
    console.log("💡 现在外部只能看到一个 'bundle.zip'，看不到具体的 json 文件名了。");

  } catch (error) {
    console.error(`💥 压缩失败: ${error.message}`);
    if (fs.existsSync(innerZipName)) fs.unlinkSync(innerZipName);
  }
}

main();

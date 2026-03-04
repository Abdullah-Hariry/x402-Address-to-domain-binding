require('dotenv').config();
const { ethers } = require('ethers');
const { Coinbase } = require('@coinbase/coinbase-sdk');
const fs = require('fs');

async function makePayment() {
  console.log('AI Agent starting payment request...\n');
  
  // Step 1: Try to access the resource (will get 402)
  console.log('Requesting data from server...');
  const response = await fetch(`${process.env.SERVER_URL}/api/data`);
  
  console.log(`Response status: ${response.status}`);
  
  if (response.status === 402) {
    const paymentDetails = await response.json();
    
    console.log('\nPayment Required:');
    console.log(`   Pay to: ${paymentDetails.payTo}`);
    console.log(`   Amount: ${paymentDetails.maxAmountRequired} (0.01 USDC)`);
    console.log(`   Network: ${paymentDetails.network}`);
    
    // Step 2: Create wallet
    const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
    const wallet = new ethers.Wallet(process.env.CLIENT_PRIVATE_KEY, provider);
    
    console.log(`Client wallet: ${wallet.address}`);
    
    const ethBalance = await provider.getBalance(wallet.address);
    
    // Fixed USDC contract creation
    const usdcAbi = ['function balanceOf(address) view returns (uint256)'];
    const usdc = new ethers.Contract(process.env.USDC_ADDRESS, usdcAbi, provider);
    const usdcBalance = await usdc.balanceOf(wallet.address);

    console.log('   ETH Balance:', ethers.formatEther(ethBalance), 'ETH');
    console.log('   USDC Balance:', ethers.formatUnits(usdcBalance, 6), 'USDC');

    if (usdcBalance < paymentDetails.maxAmountRequired) {
      console.log('\nERROR: Insufficient USDC!');
      return;
    }
    
    // Step 3: Create EIP-712 payment authorization
    const domain = {
      name: 'USDC',
      version: '2',
      chainId: parseInt(process.env.CHAIN_ID),
      verifyingContract: paymentDetails.asset
    };
    
    const types = {
      TransferWithAuthorization: [
        { name: 'from', type: 'address' },
        { name: 'to', type: 'address' },
        { name: 'value', type: 'uint256' },
        { name: 'validAfter', type: 'uint256' },
        { name: 'validBefore', type: 'uint256' },
        { name: 'nonce', type: 'bytes32' }
      ]
    };
    
    const nonce = ethers.hexlify(ethers.randomBytes(32));
    const value = {
      from: wallet.address,
      to: ethers.getAddress(paymentDetails.payTo),
      value: paymentDetails.maxAmountRequired,
      validAfter: 0,
      validBefore: Math.floor(Date.now() / 1000) + 3600,
      nonce: nonce
    };
    
    console.log('\nCreating EIP-712 signature...');
    const signature = await wallet.signTypedData(domain, types, value);
    
    console.log(`   Signature: ${signature.substring(0, 20)}...`);
    console.log(`   Authorizing payment to: ${value.to}\n`);
    
    console.log('Sending authorization to Coinbase CDP...');

    try {
      // Initialize CDP
      const credentials = JSON.parse(fs.readFileSync('./cdp-credentials.json', 'utf-8'));
      Coinbase.configure({
        apiKeyName: credentials.name,
        privateKey: credentials.privateKey
      });

      console.log('CDP initialized');
      console.log('Broadcasting transaction...');

      const sig = ethers.Signature.from(signature);

      const usdcWithSigner = new ethers.Contract(
        process.env.USDC_ADDRESS, 
        ['function transferWithAuthorization(address from, address to, uint256 value, uint256 validAfter, uint256 validBefore, bytes32 nonce, uint8 v, bytes32 r, bytes32 s) external'],
        wallet
      );

      const tx = await usdcWithSigner.transferWithAuthorization(
        value.from,
        value.to,
        value.value,
        value.validAfter,
        value.validBefore,
        nonce,
        sig.v,
        sig.r,
        sig.s
      );  

      console.log('Transaction hash:', tx.hash);
      console.log('Basescan: https://sepolia.basescan.org/tx/' + tx.hash);

      console.log('\nWaiting for blockchain confirmation...');
      const receipt = await tx.wait();
      console.log('Confirmed in block', receipt.blockNumber);

      const paidResponse = await fetch(`${process.env.SERVER_URL}/api/data`, {
        headers: {
          'X-Payment-Tx': tx.hash
        } 
      });

      if (paidResponse.ok) {
        const data = await paidResponse.json();
        console.log('\nSUCCESS: Received protected data');
        console.log(data);
        console.log('===============================================');
        console.log('Transaction:', tx.hash);
        console.log('Block:', receipt.blockNumber);
        console.log('Payment: 0.01 USDC to', value.to);
        console.log('===============================================\n');
      }

    } catch(error) {
      console.log('\nERROR:', error.message);
    }
  }
}

// Run the client
makePayment().catch(console.error);
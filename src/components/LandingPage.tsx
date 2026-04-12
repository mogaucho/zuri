import React, { useState, useEffect } from 'react';
import { motion } from 'motion/react';
import { TrendingUp, Shield, Zap, Globe, ArrowRight, BarChart3, Users } from 'lucide-react';

interface LandingPageProps {
  onStart: () => void;
}

const MarketTicker = () => {
  const [data, setData] = useState(Array.from({ length: 25 }).map((_, i) => ({
    id: i,
    pair: ["EUR/USD", "GBP/USD", "USD/JPY", "BTC/USD", "ETH/USD", "GOLD", "OIL"][Math.floor(Math.random() * 7)],
    price: (1.08 + Math.random() * 100).toFixed(4),
    change: (Math.random() * 2 - 1).toFixed(2),
    vol: (Math.random() * 100).toFixed(1),
    time: new Date().toLocaleTimeString()
  })));

  useEffect(() => {
    const interval = setInterval(() => {
      setData(prev => prev.map(item => ({
        ...item,
        price: (parseFloat(item.price) + (Math.random() - 0.5) * 0.01).toFixed(4),
        time: new Date().toLocaleTimeString()
      })));
    }, 2000);
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      {data.map((item) => (
        <div key={item.id} className="flex justify-between border-b border-slate-500/30 pb-2 text-[10px] font-mono">
          <span className="animate-pulse w-16">{item.pair}</span>
          <span className="w-20 text-right">{item.price}</span>
          <span className={`w-12 text-right ${parseFloat(item.change) >= 0 ? 'text-emerald-500' : 'text-rose-500'}`}>
            {item.change}%
          </span>
          <span className="hidden md:inline w-20 text-right">VOL: {item.vol}M</span>
          <span className="w-20 text-right">{item.time}</span>
        </div>
      ))}
    </>
  );
};

export default function LandingPage({ onStart }: LandingPageProps) {
  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 selection:bg-indigo-500/30 overflow-x-hidden">
      {/* Background Elements */}
      <div className="fixed inset-0 overflow-hidden pointer-events-none">
        <div className="absolute top-[-10%] left-[-10%] w-[40%] h-[40%] bg-indigo-500/10 blur-[120px] rounded-full" />
        <div className="absolute bottom-[-10%] right-[-10%] w-[40%] h-[40%] bg-emerald-500/10 blur-[120px] rounded-full" />
        
        {/* Actively Running Market Table Background */}
        <div className="absolute inset-0 opacity-[0.08] flex flex-col gap-4 p-4 select-none overflow-hidden">
          <MarketTicker />
        </div>
        
        <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-20 mix-blend-overlay" />
      </div>

      {/* Navigation */}
      <nav className="relative z-10 flex items-center justify-between px-6 py-8 max-w-7xl mx-auto">
        <div className="flex items-center gap-2">
          <div className="w-10 h-10 bg-gradient-to-br from-indigo-500 to-emerald-500 rounded-xl flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <TrendingUp className="text-white w-6 h-6" />
          </div>
          <span className="text-xl font-bold tracking-tight text-white">mosinhioTrade</span>
        </div>
        <div className="hidden md:flex items-center gap-8 text-sm font-medium text-slate-400">
          <a href="#features" className="hover:text-white transition-colors">Features</a>
          <a href="#arena" className="hover:text-white transition-colors">Arena</a>
          <a href="#security" className="hover:text-white transition-colors">Security</a>
        </div>
        <button 
          onClick={onStart}
          className="px-5 py-2.5 bg-white text-slate-950 rounded-full font-semibold text-sm hover:bg-slate-200 transition-all active:scale-95 shadow-xl shadow-white/10"
        >
          Enter Arena
        </button>
      </nav>

      {/* Hero Section */}
      <section className="relative z-10 pt-20 pb-32 px-6 max-w-7xl mx-auto text-center">
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.6 }}
        >
          <span className="inline-block px-4 py-1.5 rounded-full bg-indigo-500/10 border border-indigo-500/20 text-indigo-400 text-xs font-bold tracking-widest uppercase mb-6">
            The Future of FX Trading
          </span>
          <h1 className="text-5xl md:text-8xl font-black tracking-tighter text-white mb-8 leading-[0.9]">
            MASTER THE <br />
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-indigo-400 via-emerald-400 to-indigo-400 bg-[length:200%_auto] animate-gradient">MARKET ARENA</span>
          </h1>
          <p className="text-slate-400 text-lg md:text-xl max-w-2xl mx-auto mb-12 leading-relaxed">
            Experience real-time FX trading with institutional-grade tools, 
            instant M-Pesa settlement, and a global competitive leaderboard.
          </p>
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4">
            <button 
              onClick={onStart}
              className="group w-full sm:w-auto px-8 py-4 bg-indigo-600 text-white rounded-2xl font-bold text-lg hover:bg-indigo-500 transition-all flex items-center justify-center gap-2 shadow-2xl shadow-indigo-600/20"
            >
              Start Trading Now
              <ArrowRight className="w-5 h-5 group-hover:translate-x-1 transition-transform" />
            </button>
            <button className="w-full sm:w-auto px-8 py-4 bg-slate-900 text-white rounded-2xl font-bold text-lg border border-slate-800 hover:bg-slate-800 transition-all">
              View Live Trades
            </button>
          </div>
        </motion.div>

        {/* Hero Image/Mockup */}
        <motion.div 
          initial={{ opacity: 0, scale: 0.95 }}
          animate={{ opacity: 1, scale: 1 }}
          transition={{ delay: 0.3, duration: 0.8 }}
          className="mt-24 relative"
        >
          <div className="absolute inset-0 bg-indigo-500/20 blur-[100px] rounded-full scale-75" />
          <div className="relative bg-slate-900/50 border border-slate-800 rounded-3xl p-4 backdrop-blur-xl shadow-2xl">
            <div className="flex items-center gap-2 mb-4 px-2">
              <div className="w-3 h-3 rounded-full bg-red-500/50" />
              <div className="w-3 h-3 rounded-full bg-yellow-500/50" />
              <div className="w-3 h-3 rounded-full bg-green-500/50" />
              <div className="ml-4 h-6 w-64 bg-slate-800 rounded-md" />
            </div>
            <img 
              src="https://images.unsplash.com/photo-1590283603385-17ffb3a7f29f?q=80&w=2070&auto=format&fit=crop" 
              alt="Professional Trading Terminal" 
              className="rounded-xl w-full grayscale-0 opacity-90 transition-all duration-1000 object-cover h-[400px]"
              referrerPolicy="no-referrer"
            />
          </div>
        </motion.div>
      </section>

      {/* Stats Section */}
      <section className="relative z-10 py-24 border-y border-slate-900 bg-slate-950/50 backdrop-blur-sm">
        <div className="max-w-7xl mx-auto px-6 grid grid-cols-2 md:grid-cols-4 gap-12">
          {[
            { label: 'Active Traders', value: '12.4K+' },
            { label: 'Daily Volume', value: '$420M+' },
            { label: 'Settlement Time', value: '< 2s' },
            { label: 'Success Rate', value: '94%' },
          ].map((stat, i) => (
            <div key={i} className="text-center">
              <div className="text-3xl md:text-4xl font-black text-white mb-2">{stat.value}</div>
              <div className="text-xs font-bold tracking-widest uppercase text-slate-500">{stat.label}</div>
            </div>
          ))}
        </div>
      </section>

      {/* Features Grid */}
      <section id="features" className="relative z-10 py-32 px-6 max-w-7xl mx-auto">
        <div className="text-center mb-20">
          <h2 className="text-3xl md:text-5xl font-black text-white mb-6 tracking-tight">BUILT FOR PRECISION</h2>
          <p className="text-slate-400 max-w-2xl mx-auto">
            Our platform combines high-frequency execution with intuitive design, 
            giving you the edge in the world's most liquid market.
          </p>
        </div>

        <div className="grid md:grid-cols-3 gap-8">
          {[
            {
              icon: Zap,
              title: 'Instant Execution',
              desc: 'Ultra-low latency order matching ensures you get the price you see, every time.',
              color: 'text-yellow-400',
              bg: 'bg-yellow-400/10'
            },
            {
              icon: Shield,
              title: 'Secure Settlement',
              desc: 'Integrated M-Pesa payouts with multi-layer encryption for your peace of mind.',
              color: 'text-emerald-400',
              bg: 'bg-emerald-400/10'
            },
            {
              icon: BarChart3,
              title: 'Advanced Analytics',
              desc: 'Real-time pattern recognition and AI-driven market sentiment analysis.',
              color: 'text-indigo-400',
              bg: 'bg-indigo-400/10'
            },
            {
              icon: Globe,
              title: 'Global Arena',
              desc: 'Compete with traders worldwide and climb the global leaderboard for rewards.',
              color: 'text-blue-400',
              bg: 'bg-blue-400/10'
            },
            {
              icon: Users,
              title: 'Social Trading',
              desc: 'Follow top performers, copy successful strategies, and share your wins.',
              color: 'text-purple-400',
              bg: 'bg-purple-400/10'
            },
            {
              icon: TrendingUp,
              title: 'Demo Accounts',
              desc: 'Practice with KES 10,000 virtual funds before going live in the arena.',
              color: 'text-rose-400',
              bg: 'bg-rose-400/10'
            }
          ].map((feature, i) => (
            <motion.div 
              key={i}
              whileHover={{ y: -5 }}
              className="p-8 rounded-3xl bg-slate-900/50 border border-slate-800 hover:border-slate-700 transition-all"
            >
              <div className={`w-12 h-12 ${feature.bg} ${feature.color} rounded-2xl flex items-center justify-center mb-6`}>
                <feature.icon className="w-6 h-6" />
              </div>
              <h3 className="text-xl font-bold text-white mb-3">{feature.title}</h3>
              <p className="text-slate-400 leading-relaxed text-sm">{feature.desc}</p>
            </motion.div>
          ))}
        </div>
      </section>

      {/* CTA Section */}
      <section className="relative z-10 py-32 px-6">
        <div className="max-w-5xl mx-auto p-12 md:p-24 rounded-[3rem] bg-gradient-to-br from-indigo-600 to-emerald-600 relative overflow-hidden text-center">
          <div className="absolute inset-0 bg-[url('https://grainy-gradients.vercel.app/noise.svg')] opacity-30 mix-blend-overlay" />
          <div className="relative z-10">
            <h2 className="text-4xl md:text-6xl font-black text-white mb-8 tracking-tighter">READY TO CONQUER?</h2>
            <p className="text-white/80 text-lg mb-12 max-w-xl mx-auto">
              Join thousands of traders already profiting from the mosinhioTrade FX Arena. 
              Your journey to financial mastery starts here.
            </p>
            <button 
              onClick={onStart}
              className="px-12 py-5 bg-white text-slate-950 rounded-2xl font-black text-xl hover:bg-slate-100 transition-all active:scale-95 shadow-2xl shadow-black/20"
            >
              GET STARTED NOW
            </button>
          </div>
        </div>
      </section>

      {/* Footer */}
      <footer className="relative z-10 py-12 px-6 border-t border-slate-900 text-center">
        <div className="flex items-center justify-center gap-2 mb-6">
          <TrendingUp className="text-indigo-500 w-5 h-5" />
          <span className="font-bold text-white">mosinhioTrade</span>
        </div>
        <p className="text-slate-500 text-sm">
          © 2026 mosinhioTrade FX Arena. All rights reserved. <br />
          Trading involves risk. Please trade responsibly.
        </p>
      </footer>
    </div>
  );
}
